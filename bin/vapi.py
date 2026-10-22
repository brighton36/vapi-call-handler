#!/usr/bin/env python3
"""Local management tool for vapi-call-handler.

Talks to the Vapi API (phone number config) and DynamoDB/S3 (people, call
index, call archive) using your default AWS profile. No GUI — this is the
whole CRUD story.

Data model: the unit of memory is the PERSON, not the phone number.
  People table        id (slug)    -> name, myName, relationship, personalNotes,
                                      llmNotes, followUps, ...
  NumberIndex table   E.164 number -> people[]  (1 person = personal line,
                                                >1 = shared line)
  CallIndex table     callId       -> personId, number, startedAt, ...  (GSI ByPerson)
  S3 CallLogs         calls/<date>/<callId>.json  (raw transcript + messages)

Requires: secrets.json (vapiToken, vapiWebhookSecret) and local.json in the repo
root — both gitignored, see the *.example files — plus boto3, requests, pyyaml.

Usage:
  bin/vapi.py people                    # list people
  bin/vapi.py rm maria                  # delete a person (their lines drop too)
  bin/vapi.py dump                      # live Dynamo -> people.yaml on STDOUT
                                          #   (save it: `bin/vapi.py dump > people.yaml`)
  bin/vapi.py push people.yaml          # push that YAML file -> live Dynamo (authoritative)
  bin/vapi.py edit                      # dump live, open $EDITOR, push edits back
  bin/vapi.py calls --days 7            # recent calls (overall)
  bin/vapi.py calls --person maria      # everything we've discussed with maria
  bin/vapi.py call <callId>             # full archive file for one call
  bin/vapi.py vapi show                 # current phone number config
  bin/vapi.py vapi sync --url <webhook> # point number at the deployed webhook
  bin/vapi.py logs --minutes 30         # last webhook CloudWatch log lines
  bin/vapi.py logs --tail               # show recent, then follow new lines
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time

import requests
import yaml

YAML_HEADER = """\
# people.yaml — the seed and source of truth for the call-handler database.
#
# Managed via:
#   bin/vapi.py dump     # write current live data to stdout (`dump > people.yaml`)
#   bin/vapi.py push <file>  # push that YAML file into live Dynamo (authoritative)
#   bin/vapi.py edit     # dump live, open $EDITOR, and commit your edits back
# The webhook also ships a copy of this file and falls back to it if Dynamo
# is unreachable, so keep it in the repo.
#
# Fields per person:
#   id:            optional slug; derived from the name when omitted
#   first_name:    first name (required)
#   last_name:     last name (optional)
#   my_name:       which name to use when this person calls: Chris or David
#   relationship:  free-form ("mom", "neighbor", "rabbi's wife")
#   attitude:      the tone the assistant takes with them ("professional" by
#                  default, or "warm", "chatty", ...). Omit to keep the
#                  professional default.
#   phone_numbers: every line this person calls from. If TWO people list the
#                  same line, it becomes a shared line — the assistant greets
#                  generically and asks who's speaking
#   personal_notes: durable facts, hand-edited by you. The LLM / phase-3
#                   summarizer never touches this.
#   llm_notes:      notes the phase-3 summarizer maintains from call history.
#                   Hand-editable; omit the key to keep the live value.
#   follow_ups:    things to bring up on the next call
#
# This repo is PUBLIC — the committed people.yaml is a fictional sample.
# After pull/edit your local copy holds real data: never commit it.
#
"""

API = "https://api.vapi.ai"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PEOPLE_YAML = os.path.join(REPO, "people.yaml")
LOCAL_JSON = os.path.join(REPO, "local.json")
SECRETS_JSON = os.path.join(REPO, "secrets.json")


def read_local():
    """Per-machine Vapi identifiers (number/assistant GUIDs) — gitignored."""
    try:
        with open(LOCAL_JSON) as f:
            cfg = json.load(f)
    except FileNotFoundError:
        sys.exit(f"local.json is missing (see local.json.example) — it holds the Vapi number/assistant IDs")
    except json.JSONDecodeError as e:
        sys.exit(f"local.json is not valid JSON: {e}")
    for k in ("vapiMobileNumberId", "vapiAssistantId"):
        if not cfg.get(k) or cfg[k] == "00000000-0000-0000-0000-000000000000":
            sys.exit(f"local.json is missing/placeholder for '{k}' — fill it in (see local.json.example)")
    return cfg


def read_secrets():
    """Vapi token + webhook secret from gitignored secrets.json (same file
    the CDK stack reads at deploy)."""
    try:
        with open(SECRETS_JSON) as f:
            return json.load(f)
    except FileNotFoundError:
        sys.exit("secrets.json is missing (see secrets.json.example)")
    except json.JSONDecodeError as e:
        sys.exit(f"secrets.json is not valid JSON: {e}")


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "unknown"


def e164(num):
    d = re.sub(r"[^\d+]", "", num)
    return ("+" + d) if not d.startswith("+") else d


# ------------------------------------------------------------------ clients

def vapi_token():
    token = read_secrets().get("vapiToken")
    if not token:
        sys.exit("secrets.json has no vapiToken")
    return token


def vapi(method, path, body=None):
    r = requests.request(
        method,
        f"{API}{path}",
        headers={"Authorization": f"Bearer {vapi_token()}", "Content-Type": "application/json"},
        json=body,
        timeout=30,
    )
    if r.status_code >= 300:
        sys.exit(f"Vapi {r.status_code}: {r.text[:500]}")
    return r.json() if r.text else None


def dynamo():
    import boto3
    return boto3.client("dynamodb", region_name="us-west-2")


def s3():
    import boto3
    return boto3.client("s3", region_name="us-west-2")


CFN_STACK = "VapiCallHandlerStack"
# CfnOutput id in the CDK stack -> key this CLI expects
_OUTPUT_MAP = {
    "OutUrl": "url",
    "OutPeople": "People",
    "OutNumberIndex": "NumberIndex",
    "OutCallIndex": "CallIndex",
    "OutCallLogs": "CallLogs",
}


def _outputs():
    """Read the deployed stack's outputs via the CloudFormation API
    (the CDK stack's CfnOutputs, see src/vapi-call-handler.ts)."""
    import boto3
    cfn = boto3.client("cloudformation", region_name="us-west-2")
    try:
        r = cfn.describe_stacks(StackName=CFN_STACK)
    except Exception as e:
        sys.exit(f"cannot read stack '{CFN_STACK}': {e}")
    if not r["Stacks"] or r["Stacks"][0]["StackStatus"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE"):
        status = r["Stacks"][0]["StackStatus"] if r["Stacks"] else "missing"
        sys.exit(f"stack '{CFN_STACK}' is not deployed yet (status: {status}) — run `npm run deploy`")
    out = {}
    for o in r["Stacks"][0].get("Outputs", []):
        key = _OUTPUT_MAP.get(o["OutputKey"])
        if key:
            out[key] = o["OutputValue"]
    if not out:
        sys.exit(f"stack '{CFN_STACK}' has no outputs — redeploy")
    return out


def T(name):
    out = _outputs()
    if name not in out:
        sys.exit(f"'{name}' missing from the deployed stack's outputs — redeploy")
    return out[name]


def scan_all(client, table):
    rows, last = [], None
    while True:
        kw = {"TableName": table}
        if last:
            kw["ExclusiveStartKey"] = last
        r = client.scan(**kw)
        rows += r["Items"]
        last = r.get("LastEvaluatedKey")
        if not last:
            break
    return rows


def s(v):
    return {"S": str(v)}


# ------------------------------------------------------------------ helpers

def read_person(person_id):
    r = dynamo().get_item(TableName=T("People"), Key={"id": s(person_id)}, ConsistentRead=True)
    return r.get("Item")


def read_number(number):
    r = dynamo().get_item(TableName=T("NumberIndex"), Key={"number": s(number)}, ConsistentRead=True)
    return r.get("Item")


def write_person(person_id, **fields):
    item: dict = {"id": s(str(person_id).strip())}
    for k, v in fields.items():
        if v is None:
            continue
        if k == "calls":
            item[k] = {"N": str(v)}
        elif isinstance(v, list):
            # trim each element; drop ones that are empty after trimming
            vals = [str(x).strip() for x in v]
            if vals:
                item[k] = {"L": [s(x) for x in vals]}
        elif isinstance(v, str):
            v = v.strip()
            if not v:
                continue
            item[k] = s(v)
        else:
            item[k] = s(v)
    dynamo().put_item(TableName=T("People"), Item=item)


def number_people(item):
    return [x["S"] for x in (item or {}).get("people", {}).get("L", [])]


def write_number(number, people):
    slugs = [str(p).strip() for p in people if str(p).strip()]
    item = {"number": s(str(number).strip()), "people": {"L": [s(p) for p in slugs]}}
    dynamo().put_item(TableName=T("NumberIndex"), Item=item)


def detach_number(slug, number):
    """Remove a person from a line. Delete the line if no one's left on it."""
    n = e164(number)
    people = number_people(read_number(n))
    if slug not in people:
        return
    rest = [p for p in people if p != slug]
    if rest:
        write_number(n, rest)
        print(f"  removed {slug} from {n} (left: {', '.join(rest)})")
    else:
        dynamo().delete_item(TableName=T("NumberIndex"), Key={"number": s(n)})
        print(f"  removed {slug} from {n}; line removed (no one left)")


# ------------------------------------------------------------------ people

def cmd_people(_a):
    ddb = dynamo()
    rows = scan_all(ddb, T("People"))
    numrows = scan_all(ddb, T("NumberIndex"))
    if not rows:
        print("(no people in Dynamo yet — run `bin/vapi.py push`)")
        return
    for it in sorted(rows, key=lambda x: x["id"]["S"]):
        g = lambda k: it.get(k, {}).get("S", "")
        display = " ".join(x for x in (g("firstName"), g("lastName")) if x) or g("name") or it["id"]["S"]
        person_nums = [
            nr["number"]["S"] for nr in numrows if it["id"]["S"] in number_people(nr)
        ]
        person_nums_shared = [
            nr["number"]["S"] for nr in numrows
            if it["id"]["S"] in number_people(nr) and len(number_people(nr)) > 1
        ]
        print(f"{it['id']['S']:<12} {display:<18} my={g('myName') or '?':<6} "
              f"rel={g('relationship'):<10} calls={it.get('calls', {}).get('N', '0'):<3} "
              f"nums={', '.join(person_nums) or '-'}")
        if person_nums_shared:
            print(f"    shared lines: {', '.join(person_nums_shared)}")
        n = lambda k: it.get(k, {}).get("N")
        if n("callsLast30d"):
            print(f"    calls: {n('callsLast24h') or 0} / 24h, {n('callsLast7d') or 0} / 7d, "
                  f"{n('callsLast30d')} / 30d  (as of {g('frequencyUpdatedAt')[:16]})")
        if g("personalNotes"):
            print(f"    personalNotes: {g('personalNotes')[:100]}")
        if g("llmNotes"):
            print(f"    llmNotes:      {g('llmNotes')[:100]}")
        if g("followUps"):
            print(f"    followUps: {g('followUps')[:100]}")


def cmd_rm(a):
    if not read_person(a.slug):
        sys.exit(f"{a.slug} not found")
    # remove this person from every line they're on (drops the line if empty)
    for nr in scan_all(dynamo(), T("NumberIndex")):
        if a.slug in number_people(nr):
            detach_number(a.slug, nr["number"]["S"])
    dynamo().delete_item(TableName=T("People"), Key={"id": s(a.slug)})
    print(f"removed {a.slug} (CallIndex rows kept as history)")


# ------------------------------------------------------------------ YAML <-> Dynamo

def live_people():
    """Read the live People + NumberIndex tables into a list of file-shaped dicts,
    ordered by id, with phone_numbers gathered from the lines that reference them."""
    ddb = dynamo()
    people_rows = scan_all(ddb, T("People"))
    numrows = scan_all(ddb, T("NumberIndex"))
    numbers_by_id = {}
    for nr in numrows:
        for pid in number_people(nr):
            numbers_by_id.setdefault(pid, []).append(nr["number"]["S"])
    out = []
    for it in sorted(people_rows, key=lambda x: x["id"]["S"]):
        pid = it["id"]["S"]
        g = lambda k: it.get(k, {}).get("S")
        first, last = g("firstName"), g("lastName")
        # pre-rename rows only have `name`: surface it as first_name so the
        # dump always yields the new shape.
        if not first and g("name"):
            first = g("name")
        if not first:
            first = pid
        entry = {"id": pid, "first_name": first, "my_name": g("myName") or "Chris"}
        if last:
            entry["last_name"] = last
        if g("relationship"):
            entry["relationship"] = g("relationship")
        if g("attitude"):
            entry["attitude"] = g("attitude")
        nums = sorted(numbers_by_id.get(pid, []))
        if nums:
            entry["phone_numbers"] = nums
        if g("personalNotes"):
            entry["personal_notes"] = g("personalNotes")
        elif g("profile"):  # pre-rename rows: migrate legacy `profile`
            entry["personal_notes"] = g("profile")
        if g("llmNotes"):
            entry["llm_notes"] = g("llmNotes")
        if g("followUps"):
            entry["follow_ups"] = g("followUps")
        out.append(entry)
    return out


def render_yaml(people):
    """The full file (header + data) as a string. `dump` prints this to
    stdout; `write_yaml` (used by `edit`) is the same bytes to a path."""
    out = YAML_HEADER
    if people:
        out += yaml.safe_dump({"people": people}, sort_keys=False, default_flow_style=False)
    else:
        out += "people: []\n"
    return out


def write_yaml(path, people):
    with open(path, "w") as f:
        f.write(render_yaml(people))


def read_yaml(path):
    """Parse the people YAML -> (list_of_entries). Each entry: id?, first_name, last_name?, ...
    String values are stripped of leading/trailing whitespace here (and again
    in the write paths), so whitespace can't reach Dynamo."""
    if not os.path.exists(path):
        sys.exit(f"{path} not found — create it first, or run `bin/vapi.py dump > people.yaml`")
    with open(path) as f:
        doc = yaml.safe_load(f) or {}
    people = doc.get("people") or []
    clean = []
    for i, p in enumerate(people):
        if not isinstance(p, dict):
            sys.exit(f"people[{i}] is not a mapping — fix {path}")
        # Trim all string values up front.
        p = {k: (v.strip() if isinstance(v, str) else v) for k, v in p.items()}
        if not (p.get("first_name") or p.get("name")):
            sys.exit(f"people[{i}] is missing a first_name — fix {path}")
        # A bare number parses as an int and would clobber the slug-based key
        # everywhere (Dynamo, CLI queries). id must be a string slug or absent.
        if "id" in p and not isinstance(p["id"], str):
            sys.exit(f"people[{i}].id must be a quoted string slug (or omitted) — got {p['id']!r}")
        clean.append(p)
    return clean


def full_name(entry):
    """Display name from first/last (or the legacy single `name`)."""
    parts = [entry.get("first_name"), entry.get("last_name")]
    parts = [p.strip() for p in parts if p and str(p).strip()]
    return " ".join(parts) or (entry.get("name") or "").strip()


def resolve_slug(entry):
    return (entry.get("id") or "").strip() or slugify(full_name(entry))


def push_file_to_live(path):
    """Authoritative: make live Dynamo match the people YAML at `path`.
    - people in the file but not live  -> created
    - people in live but not the file  -> removed (their lines detached)
    - first_name/last_name/my_name/relationship/notes/follow_ups -> overwritten
    - phone_numbers -> NumberIndex rebuilt to match the file exactly
    - calls/lastCalled -> preserved (owned by the webhook + summarizer, not the file)
    """
    ddb = dynamo()
    file_entries = read_yaml(path)
    file_slugs = {}
    for e in file_entries:
        file_slugs[resolve_slug(e)] = e

    # 1) write people rows (upsert). The file is the source of truth, so
    #    absent notes/follow_ups clear the live value ("or ''").
    #    calls/lastCalled are owned by the webhook/summarizer, so preserved.
    for slug, e in file_slugs.items():
        existing = read_person(slug)
        # pre-rename rows: legacy `profile` becomes personalNotes. PutItem
        # replaces the whole item, so the stale attribute is dropped for free.
        personal_notes = e.get("personal_notes") or ""
        if not personal_notes and (existing or {}).get("profile"):
            personal_notes = existing["profile"]["S"]
        # name migration: new files use first_name/last_name; a legacy file
        # with only `name` migrates into firstName.
        first = e.get("first_name") or e.get("name") or ""
        last = e.get("last_name") or ""
        write_person(
            slug,
            firstName=first or None,
            lastName=last or None,
            myName=e.get("my_name") or "Chris",
            relationship=e.get("relationship") or "",
            attitude=e.get("attitude") or "",
            personalNotes=personal_notes,
            # llm_notes is summarizer-owned: omitted from the file -> keep the
            # live value, so a stale file can't wipe what the LLM wrote.
            llmNotes=e["llm_notes"] if "llm_notes" in e else (existing or {}).get("llmNotes", {}).get("S"),
            followUps=e.get("follow_ups") or "",
            lastCalled=(existing or {}).get("lastCalled", {}).get("S"),
            calls=int((existing or {}).get("calls", {}).get("N", "0")) if (existing or {}).get("calls") else None,
        )

    # 2) rebuild NumberIndex from the file
    desired = {}  # number -> [slugs]
    for slug, e in file_slugs.items():
        for num in e.get("phone_numbers") or []:
            desired.setdefault(e164(num), []).append(slug)
    live_numbers = {nr["number"]["S"]: number_people(nr) for nr in scan_all(ddb, T("NumberIndex"))}

    for num, slugs in sorted(desired.items()):
        if live_numbers.get(num) != sorted(slugs):
            write_number(num, sorted(slugs))
            kind = "shared" if len(slugs) > 1 else "personal"
            print(f"  line {num} ({kind}): {', '.join(sorted(slugs))}")
    for num, slugs in sorted(live_numbers.items()):
        if num not in desired:
            ddb.delete_item(TableName=T("NumberIndex"), Key={"number": s(num)})
            print(f"  line {num}: removed")

    # 3) remove people that are in live but not the file
    live_slugs = {r["id"]["S"] for r in scan_all(ddb, T("People"))}
    for slug in sorted(live_slugs - set(file_slugs)):
        for num, slugs in list(live_numbers.items()):
            if slug in slugs:
                detach_number(slug, num)
        ddb.delete_item(TableName=T("People"), Key={"id": s(slug)})
        print(f"  removed person {slug} (not in file)")

    print(f"live now matches {path} ({len(file_slugs)} people)")


def cmd_dump(_a):
    """Write the live People + NumberIndex data as people.yaml to STDOUT.
    Redirect it to save: `bin/vapi.py dump > people.yaml`."""
    sys.stdout.write(render_yaml(live_people()))


def cmd_push(a):
    push_file_to_live(a.path)


def cmd_edit(_a):
    editor = os.environ.get("EDITOR") or os.environ.get("VISUAL")
    if not editor:
        sys.exit("set $EDITOR (or $VISUAL) first")
    # Back up the file, then overwrite it with the live data to edit.
    backup = PEOPLE_YAML + ".bak"
    if os.path.exists(PEOPLE_YAML):
        with open(PEOPLE_YAML, "rb") as f:
            with open(backup, "wb") as b:
                b.write(f.read())
    original = read_yaml(PEOPLE_YAML) if os.path.exists(PEOPLE_YAML) else []
    write_yaml(PEOPLE_YAML, live_people())
    print(f"opened {PEOPLE_YAML} for editing (live data) — Ctrl-C or save to continue")
    rc = subprocess.call(editor + " " + PEOPLE_YAML, shell=True)
    if rc != 0:
        if os.path.exists(backup):
            import shutil
            shutil.move(backup, PEOPLE_YAML)
        sys.exit(f"editor exited {rc}; restored the previous file, nothing committed")
    try:
        edited = read_yaml(PEOPLE_YAML)
    except SystemExit:
        if os.path.exists(backup):
            import shutil
            shutil.move(backup, PEOPLE_YAML)
        raise
    os.remove(backup)
    if edited == original:
        print("no changes made; nothing to commit")
        return
    print(f"committing {len(edited)} people back to live Dynamo...")
    push_file_to_live(PEOPLE_YAML)


# ------------------------------------------------------------------ calls

def cmd_calls(a):
    ddb = dynamo()
    table = T("CallIndex")
    if a.person:
        # everything we've discussed with this person, newest first
        r = ddb.query(
            TableName=table,
            IndexName="ByPerson",
            KeyConditionExpression="personId = :p",
            ExpressionAttributeValues={":p": s(a.person)},
            ScanIndexForward=False,
            Limit=a.limit,
        )
        rows = r["Items"]
        print(f"--- {a.person}: {len(rows)} call(s) ---")
    else:
        import datetime
        cutoff = (datetime.date.today() - datetime.timedelta(days=a.days)).isoformat()
        rows = [it for it in scan_all(ddb, table) if it.get("startedAt", {}).get("S", "") >= cutoff]
        rows.sort(key=lambda x: x["startedAt"]["S"], reverse=True)
        rows = rows[: a.limit]
        print(f"--- last {a.days} days: {len(rows)} call(s) ---")
    for it in rows:
        g = lambda k: it.get(k, {}).get("S", "")
        dur = it.get("durationSeconds", {}).get("N")
        dur_s = f"{int(dur) // 60}m{int(dur) % 60:02d}s" if dur else "?"
        print(f"{it['startedAt']['S'][:16]}  {dur_s:>7}  {g('number'):<14} {g('personId') or 'unknown':<10} "
              f"${it.get('cost', {}).get('N', '0'):<8} {g('endedReason')}")
        if g("llmNotes"):
            print(f"    {g('llmNotes')[:140]}")
    if not rows:
        print("(no matching calls)")


def cmd_call(a):
    bucket = T("CallLogs")
    r = s3().list_objects_v2(Bucket=bucket, Prefix="calls/")
    for o in r.get("Contents", []):
        if a.call_id in o["Key"]:
            print(json.dumps(json.loads(s3().get_object(Bucket=bucket, Key=o["Key"])["Body"].read()), indent=2))
            return
    sys.exit(f"no archive file matching {a.call_id}")


# ------------------------------------------------------------------ logs

# The lambda function name in CDK (src/vapi-call-handler.ts) is
# `vapi-call-handler-<function>`; CloudWatch keeps logs at /aws/lambda/<name>.
LOG_NAME = "vapi-call-handler"

# Lambda log lines are "<ISO ts>\t<requestId>\t<LEVEL>\t<message>", where
# message may span lines (console.info with an object). Lambda's own bookkeeping
# (START/END/REPORT/INIT) gets filtered out, not parsed.
_LEVEL_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T[\d:.]+Z\t[\w-]+\t(INFO|WARN|ERROR|DEBUG)\t?")
_LAMBDA_NOISE = ("START RequestId", "END RequestId", "REPORT RequestId", "INIT_START", "INIT_END")


def _fmt_line(ev):
    m = _LEVEL_RE.match(ev["message"])
    level = m.group(1) if m else ""
    body = (ev["message"][m.end():] if m else ev["message"]).rstrip()
    ts = datetime.datetime.fromtimestamp(ev["timestamp"] / 1000).strftime("%H:%M:%S")
    return f"[{ts}] {level:<5} {body}"


# CloudWatch flake (observed, 2026-10-21, us-west-2): a filter_log_events with
# a wide start time (~3.5 days back against a log group that only has a few
# days of data) DETERMINISTICALLY returns 0 events, while the same data is
# returned when the window starts a few hours wider, and 3h sub-chunks cover
# the data every time. Don't fight it: query in chunks and merge.
_CHUNK_MS = 24 * 3600 * 1000


def _fetch_chunk(logs, group, start_ms, end_ms):
    """One chunk, paginated (Limit=100/page), with a few retries — a single
    transient failure must not turn into "no log lines"."""
    for attempt in range(3):
        try:
            out, token = [], None
            while True:
                kw = {"logGroupName": group, "startTime": start_ms, "endTime": end_ms, "limit": 100}
                # camelCase: this botocore build is case-sensitive on parameter names.
                if token:
                    kw["nextToken"] = token
                r = logs.filter_log_events(**kw)
                out += r.get("events", [])
                token = r.get("NextToken")
                if not token:
                    return out
            return out
        except logs.exceptions.InvalidParameterException:
            raise  # our window math is wrong; don't retry that
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))


def _chunked_events(logs, group, start_ms, end_ms):
    """All events in [start_ms, end_ms), oldest first. The range is split into
    _CHUNK_MS windows because wide windows flake (see _CHUNK_MS note); results
    are deduped in case chunks overlap a boundary."""
    chunks = []
    for s in range(start_ms, end_ms, _CHUNK_MS):
        e = min(s + _CHUNK_MS, end_ms)
        chunks.append(_fetch_chunk(logs, group, s, e))
    events, seen = [], set()
    for c in chunks:
        for ev in sorted(c, key=lambda x: x["timestamp"]):
            key = (ev["timestamp"], ev["message"])
            if key in seen:
                continue
            seen.add(key)
            events.append(ev)
    return events


def _poll_new(logs, group, seen, since_ms):
    """Events strictly after `since_ms`, deduped against `seen` and printed.
    Returns the newest timestamp seen (for the next poll)."""
    last = since_ms
    for e in _chunked_events(logs, group, since_ms + 1, int(time.time() * 1000)):
        if e["message"].startswith(_LAMBDA_NOISE):
            continue  # Lambda bookkeeping, same filter as the initial fetch
        key = (e["timestamp"], e["message"])
        if key in seen:
            continue
        seen.add(key)
        last = max(last, e["timestamp"])
        if len(seen) > 1000:  # bound memory; keep the recent half
            seen = set(sorted(seen)[-500:])
        print(_fmt_line(e))
        sys.stdout.flush()
    return last


def _spinner_line(poll_s, since_last_line_s):
    """The in-place tail status: spinner + how long since the last line."""
    frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
    frame = frames[int(time.time() * 5) % len(frames)]
    return (f"\r{frame} tailing — {since_last_line_s:.0f}s since last line "
            f"(poll {poll_s}s) — Ctrl-C to stop")


def _clear_status():
    # Erase the spinner line (including anything it overran) before printing
    # real log lines, so they land on their own lines.
    sys.stdout.write("\r\033[K")
    sys.stdout.flush()


def cmd_logs(a):
    import boto3
    logs = boto3.client("logs", region_name="us-west-2")
    group = f"/aws/lambda/{LOG_NAME}-{a.function}"
    start_ms = int((time.time() - a.minutes * 60) * 1000)
    end_ms = int(time.time() * 1000)
    try:
        events = _chunked_events(logs, group, start_ms, end_ms)
    except logs.exceptions.ResourceNotFoundException:
        sys.exit(f"no log group for {group} yet — does the function exist, and has it run?")
    events.reverse()  # newest first
    events = [e for e in events if not e["message"].startswith(_LAMBDA_NOISE)]
    events = events[: a.limit]
    for e in events:
        print(_fmt_line(e))
    if len(events) == a.limit:
        print(f"… showing {a.limit} newest; widen --minutes or raise --limit")
    if not a.tail:
        return

    seen = {(e["timestamp"], e["message"]) for e in events}
    if events:
        last_ts = max(seen)[0]
    else:
        # Nothing in the window: poll forward from now, and measure idle time
        # from now so the heartbeat doesn't claim we've been quiet for hours.
        print(f"(no log lines in the last {a.minutes} min for {a.function})")
        last_ts = int(time.time() * 1000)
    # On a tty the status is a spinner line redrawn in place (\r, no newline).
    # Piped/redirected output can't do that, so fall back to a periodic line.
    tty = sys.stdout.isatty()
    if not tty:
        print(f"(tail: polling every {a.poll}s — Ctrl-C to stop)")
        sys.stdout.flush()
    try:
        while True:
            # Sleep in short slices so the spinner ticks between polls.
            deadline = time.time() + a.poll
            while time.time() < deadline:
                if tty and not a.quiet:
                    sys.stdout.write(_spinner_line(a.poll, time.time() - last_ts / 1000) + "\033[K")
                    sys.stdout.flush()
                time.sleep(0.2)
            if tty:
                _clear_status()
            last_ts = _poll_new(logs, group, seen, last_ts)
            if not tty and time.time() - last_ts / 1000 >= 30 and not a.quiet:
                # Heartbeat so an idle poll visibly keeps running: "no log
                # lines yet" must not read as "the command ended."
                print(f"(idle {int(time.time() - last_ts / 1000)}s — still polling, Ctrl-C to stop)")
                sys.stdout.flush()
    except KeyboardInterrupt:
        if tty:
            _clear_status()
        print("\nstopped")


# ------------------------------------------------------------------ vapi

def cmd_vapi_show(_a):
    nid = read_local()["vapiMobileNumberId"]
    print(json.dumps(vapi("GET", f"/phone-number/{nid}"), indent=2))


def cmd_vapi_sync(a):
    url = a.url or _outputs().get("url")
    local = read_local()
    credential_id = a.credential or local.get("vapiCredentialId")
    if not url:
        sys.exit("need --url (the Function URL — also read from the deployed stack's outputs after `npm run deploy`)")
    if not credential_id or credential_id == "00000000-0000-0000-0000-000000000000":
        sys.exit(
            "need a Vapi custom credential: --credential <id> or vapiCredentialId in local.json.\n"
            "Create it in the dashboard (Settings > Integrations > Server Configuration >\n"
            "Add Custom Credential, type Bearer Token, Header Name 'Authorization',\n"
            "Include Bearer Prefix ON, Token = vapiWebhookSecret from secrets.json),\n"
            "then paste its id into local.json."
        )
    fallback_sip = a.fallback_sip or local.get("fallbackSipUri")
    fallback = a.fallback_number or local.get("fallbackNumber")
    if fallback_sip:
        # SIP fallback rings your own line (e.g. voip.ms) — no second Vapi
        # number in the loop, no self-forward.
        dest = {"type": "sip", "sipUri": fallback_sip, "message": ""}
    elif fallback and re.fullmatch(r"\+\d{8,15}", fallback):
        dest = {"type": "number", "number": fallback, "message": ""}
    else:
        sys.exit(
            "need a fallback: --fallback-sip <sipUri> / fallbackSipUri in local.json "
            "(preferred — a SIP URI to your own line), "
            "or --fallback-number / fallbackNumber (an E.164 number; must NOT be the Vapi number itself)"
        )
    body = {
        "server": {
            "url": url,
            "credentialId": credential_id,
            "timeoutSeconds": 7,  # reply must land inside 7.5s end-to-end
            # Explicit empty map: a PATCH that omits `headers` does NOT clear
            # them, so a stale inline secret would linger on the number.
            "headers": {},
        },
        "fallbackDestination": dest,
    }
    n = vapi("PATCH", f"/phone-number/{local['vapiMobileNumberId']}", body)
    print(json.dumps({k: n.get(k) for k in ("name", "number", "server", "fallbackDestination")}, indent=2))
    print("\nMobile number now routes inbound calls through the webhook.")
    print("Vapi authenticates each webhook with Authorization: Bearer <credential token>.")
    print("Test: call it from a known and an unknown number, then `bin/vapi.py calls`.")


# ------------------------------------------------------------------ main

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("people").set_defaults(fn=cmd_people)

    r = sub.add_parser("rm")
    r.add_argument("slug")
    r.set_defaults(fn=cmd_rm)

    sub.add_parser("dump", help="write live Dynamo as people.yaml to stdout (save: `dump > people.yaml`)").set_defaults(fn=cmd_dump)
    pp = sub.add_parser("push", help="push a people YAML file into live Dynamo (authoritative)")
    pp.add_argument("path", help="path to the people YAML file to push (e.g. people.yaml)")
    pp.set_defaults(fn=cmd_push)
    sub.add_parser("edit", help="dump live, open $EDITOR, and push edits back").set_defaults(fn=cmd_edit)

    c = sub.add_parser("calls")
    c.add_argument("--person", help="slug: everything discussed with this person")
    c.add_argument("--days", type=int, default=7)
    c.add_argument("--limit", type=int, default=25)
    c.set_defaults(fn=cmd_calls)

    cl = sub.add_parser("call")
    cl.add_argument("call_id")
    cl.set_defaults(fn=cmd_call)

    lg = sub.add_parser("logs", help="webhook CloudWatch logs (newest first)")
    lg.add_argument("--function", choices=["webhook", "after-call"], default="webhook")
    lg.add_argument("--minutes", type=int, default=30, help="look back N minutes (default 30)")
    lg.add_argument("--limit", type=int, default=50, help="max lines to show (default 50)")
    lg.add_argument("--tail", action="store_true", help="keep printing new lines as they arrive")
    lg.add_argument("--poll", type=int, default=5, help="tail poll interval seconds (default 5)")
    lg.add_argument("--quiet", action="store_true", help="no spinner/heartbeat while tailing — log lines only")
    lg.set_defaults(fn=cmd_logs)

    v = sub.add_parser("vapi")
    vsub = v.add_subparsers(dest="vcmd", required=True)
    vsub.add_parser("show").set_defaults(fn=cmd_vapi_show)
    s_ = vsub.add_parser("sync")
    s_.add_argument("--url")
    s_.add_argument("--credential", help="custom credential id (defaults to vapiCredentialId in local.json)")
    s_.add_argument("--fallback-sip", help="SIP fallback URI (preferred; defaults to fallbackSipUri in local.json)")
    s_.add_argument("--fallback-number", help="E.164 fallback number (defaults to fallbackNumber in local.json)")
    s_.set_defaults(fn=cmd_vapi_sync)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
