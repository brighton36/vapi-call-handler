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
  bin/vapi.py people                          # list people
  bin/vapi.py add maria Maria --my-name David --relationship mom --number +15550123400
  bin/vapi.py add-number maria +15550123401     # another line for the same person
  bin/vapi.py update maria --notes "Milo has a vet appt the 22nd"   # personal notes
  bin/vapi.py update maria --llm-notes "..."                        # the LLM-maintained notes
  bin/vapi.py rm maria
  bin/vapi.py line show +15550123403          # who uses this line
  bin/vapi.py line add +15550123403 ruth noah   # make it a shared line
  bin/vapi.py line rm  +15550123403 noah       # remove noah from the line
  bin/vapi.py pull                      # write live Dynamo -> people.yaml
  bin/vapi.py sync                      # push people.yaml -> live Dynamo (authoritative)
  bin/vapi.py edit                      # pull, open $EDITOR, commit edits back
  bin/vapi.py calls --days 7                  # recent calls (overall)
  bin/vapi.py calls --person maria              # everything we've discussed with maria
  bin/vapi.py call <callId>                   # full archive file for one call
  bin/vapi.py vapi show                       # current phone number config
  bin/vapi.py vapi sync --url <webhook>       # point number at the deployed webhook
"""
import argparse
import json
import os
import re
import subprocess
import sys

import requests
import yaml

YAML_HEADER = """\
# people.yaml — the seed and source of truth for the call-handler database.
#
# Managed via:
#   bin/vapi.py pull     # write current live data into this file
#   bin/vapi.py sync     # push this file into live Dynamo (authoritative)
#   bin/vapi.py edit     # pull, open $EDITOR, and commit your edits back
# The webhook also ships a copy of this file and falls back to it if Dynamo
# is unreachable, so keep it in the repo.
#
# Fields per person:
#   id:            optional slug; derived from name when omitted
#   name:          display name (required)
#   my_name:       which name to use when this person calls: Chris or David
#   relationship:  free-form ("mom", "neighbor", "rabbi's wife")
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
    if not r["Stacks"] or r["Stacks"][0]["StackStatus"] != "CREATE_COMPLETE":
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
    item = {"id": s(person_id)}
    for k, v in fields.items():
        if v is None:
            continue
        if k == "calls":
            item[k] = {"N": str(v)}
        elif isinstance(v, list):
            item[k] = {"L": [s(x) for x in v]}
        else:
            item[k] = s(v)
    dynamo().put_item(TableName=T("People"), Item=item)


def number_people(item):
    return [x["S"] for x in (item or {}).get("people", {}).get("L", [])]


def write_number(number, people):
    item = {"number": s(number), "people": {"L": [s(p) for p in people]}}
    dynamo().put_item(TableName=T("NumberIndex"), Item=item)


def line_exists(number):
    return number in number_people(read_number(number))


def set_line(number, people):
    write_number(number, people)


def attach_number(slug, number):
    """Add a line to a person. A line is personal if only this person uses it;
    if anyone else already uses it, add this person to the (now shared) list."""
    n = e164(number)
    people = number_people(read_number(n))
    if not people:
        write_number(n, [slug])
        print(f"  -> {n} -> {slug}")
        return
    if slug in people:
        print(f"  ! {slug} already on {n}; no change")
        return
    write_number(n, people + [slug])
    if len(people) >= 1:
        print(f"  -> {n} now shared: {', '.join(people + [slug])}")
    else:
        print(f"  -> {n} -> {slug}")


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
        print("(no people in Dynamo yet — run `bin/vapi.py sync`)")
        return
    for it in sorted(rows, key=lambda x: x["id"]["S"]):
        g = lambda k: it.get(k, {}).get("S", "")
        person_nums = [
            nr["number"]["S"] for nr in numrows if it["id"]["S"] in number_people(nr)
        ]
        person_nums_shared = [
            nr["number"]["S"] for nr in numrows
            if it["id"]["S"] in number_people(nr) and len(number_people(nr)) > 1
        ]
        print(f"{it['id']['S']:<12} {g('name'):<14} my={g('myName') or '?':<6} "
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


def cmd_add(a):
    slug = slugify(a.name)
    if read_person(slug):
        sys.exit(f"person {slug} already exists (use update / add-number)")
    write_person(slug, name=a.name, myName=a.my_name, relationship=a.relationship, personalNotes=a.notes)
    print(f"added person {slug} ({a.name})")
    for num in a.number or []:
        attach_number(slug, num)


def cmd_add_number(a):
    if not read_person(a.slug):
        sys.exit(f"{a.slug} not found")
    attach_number(a.slug, a.number)


def cmd_update(a):
    person = read_person(a.slug)
    if not person:
        sys.exit(f"{a.slug} not found")
    d = {
        "name": a.name or person.get("name", {}).get("S"),
        "myName": a.my_name or person.get("myName", {}).get("S"),
        "relationship": a.relationship or person.get("relationship", {}).get("S"),
        "personalNotes": a.notes if a.notes is not None else person.get("personalNotes", {}).get("S"),
        "llmNotes": a.llm_notes if a.llm_notes is not None else person.get("llmNotes", {}).get("S"),
        "followUps": a.follow_ups if a.follow_ups is not None else person.get("followUps", {}).get("S"),
        "lastCalled": person.get("lastCalled", {}).get("S"),
        "calls": int(person["calls"]["N"]) if person.get("calls") else None,
    }
    write_person(a.slug, **d)
    print(f"updated {a.slug}")


def cmd_rm(a):
    if not read_person(a.slug):
        sys.exit(f"{a.slug} not found")
    # remove this person from every line they're on (drops the line if empty)
    for nr in scan_all(dynamo(), T("NumberIndex")):
        if a.slug in number_people(nr):
            detach_number(a.slug, nr["number"]["S"])
    dynamo().delete_item(TableName=T("People"), Key={"id": s(a.slug)})
    print(f"removed {a.slug} (CallIndex rows kept as history)")


def cmd_line(a):
    n = e164(a.number)
    if a.lcmd == "show":
        people = number_people(read_number(n))
        if not people:
            print(f"{n}: no one mapped to this line yet")
            return
        kind = "shared" if len(people) > 1 else "personal"
        print(f"{n} ({kind}): {', '.join(people)}")
        return
    if a.lcmd == "add":
        # validate all the people exist
        for p in a.people:
            if not read_person(p):
                sys.exit(f"person {p} not found — add them first")
        existing = number_people(read_number(n))
        updated = list(existing)
        for p in a.people:
            if p not in updated:
                updated.append(p)
        if not updated:
            sys.exit(f"{n}: nothing to set")
        write_number(n, updated)
        kind = "shared" if len(updated) > 1 else "personal"
        print(f"{n} ({kind}): {', '.join(updated)}")
        return
    if a.lcmd == "rm":
        for p in a.people:
            detach_number(p, n)
        return


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
        entry = {"id": pid, "name": g("name") or pid, "my_name": g("myName") or "Chris"}
        if g("relationship"):
            entry["relationship"] = g("relationship")
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


def write_yaml(path, people):
    with open(path, "w") as f:
        f.write(YAML_HEADER)
        if people:
            f.write(yaml.safe_dump({"people": people}, sort_keys=False, default_flow_style=False))
        else:
            f.write("people: []\n")


def read_yaml(path):
    """Parse people.yaml -> (list_of_entries). Each entry: id?, name, my_name, ..."""
    if not os.path.exists(path):
        sys.exit(f"{path} not found — create it first, or run `bin/vapi.py pull`")
    with open(path) as f:
        doc = yaml.safe_load(f) or {}
    people = doc.get("people") or []
    clean = []
    for i, p in enumerate(people):
        if not isinstance(p, dict) or not p.get("name"):
            sys.exit(f"people[{i}] is missing a name — fix {path}")
        clean.append(p)
    return clean


def resolve_slug(entry):
    return entry.get("id") or slugify(entry["name"])


def sync_file_to_live():
    """Authoritative: make live Dynamo match people.yaml.
    - people in the file but not live  -> created
    - people in live but not the file  -> removed (their lines detached)
    - name/my_name/relationship/notes/follow_ups -> overwritten from the file
    - phone_numbers -> NumberIndex rebuilt to match the file exactly
    - calls/lastCalled -> preserved (owned by the webhook + summarizer, not the file)
    """
    ddb = dynamo()
    file_entries = read_yaml(PEOPLE_YAML)
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
        write_person(
            slug,
            name=e.get("name"),
            myName=e.get("my_name") or "Chris",
            relationship=e.get("relationship") or "",
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

    print(f"live now matches {PEOPLE_YAML} ({len(file_slugs)} people)")


def cmd_pull(_a):
    people = live_people()
    write_yaml(PEOPLE_YAML, people)
    print(f"wrote {len(people)} people from live Dynamo to {PEOPLE_YAML}")


def cmd_sync(_a):
    sync_file_to_live()


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
    sync_file_to_live()


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


# ------------------------------------------------------------------ vapi

def cmd_vapi_show(_a):
    nid = read_local()["vapiMobileNumberId"]
    print(json.dumps(vapi("GET", f"/phone-number/{nid}"), indent=2))


def cmd_vapi_sync(a):
    url = a.url or _outputs().get("url")
    secret = a.secret or read_secrets().get("vapiWebhookSecret")
    if not url:
        sys.exit("need --url (the Function URL — also read from the deployed stack's outputs after `npm run deploy`)")
    if not secret:
        sys.exit("need --secret or vapiWebhookSecret in secrets.json")
    fallback = a.fallback_number or read_local().get("fallbackNumber")
    if not fallback or not re.fullmatch(r"\+\d{8,15}", fallback):
        sys.exit("need a real E.164 fallback: --fallback-number or fallbackNumber in local.json")
    body = {
        "server": {
            "url": url,
            "headers": {"x-vapi-webhook-secret": secret},
            "timeoutSeconds": 7,  # reply must land inside 7.5s end-to-end
        },
        "fallbackDestination": {
            "type": "number",
            "number": fallback,
            "message": "",
        },
    }
    n = vapi("PATCH", f"/phone-number/{read_local()['vapiMobileNumberId']}", body)
    print(json.dumps({k: n.get(k) for k in ("name", "number", "server", "fallbackDestination")}, indent=2))
    print("\nMobile number now routes inbound calls through the webhook.")
    print("Test: call it from a known and an unknown number, then `bin/vapi.py calls`.")


# ------------------------------------------------------------------ main

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("people").set_defaults(fn=cmd_people)

    a = sub.add_parser("add", help="create a person")
    a.add_argument("name", help="display name (slug is derived)")
    a.add_argument("--my-name", help='"Chris" or "David"')
    a.add_argument("--relationship")
    a.add_argument("--notes", help="personal notes (hand-edited; the LLM never writes these)")
    a.add_argument("--number", action="append", help="line they call from (repeatable)")
    a.set_defaults(fn=cmd_add)

    an = sub.add_parser("add-number", help="attach another line to an existing person")
    an.add_argument("slug")
    an.add_argument("number")
    an.set_defaults(fn=cmd_add_number)

    u = sub.add_parser("update")
    u.add_argument("slug")
    u.add_argument("--name")
    u.add_argument("--my-name")
    u.add_argument("--relationship")
    u.add_argument("--notes", help="personal notes (hand-edited; the LLM never writes these)")
    u.add_argument("--llm-notes", help="the LLM-maintained notes")
    u.add_argument("--follow-ups")
    u.set_defaults(fn=cmd_update)

    r = sub.add_parser("rm")
    r.add_argument("slug")
    r.set_defaults(fn=cmd_rm)

    sh = sub.add_parser("line", help="who uses a given phone line (show/add/rm)")
    shsub = sh.add_subparsers(dest="lcmd", required=True)
    shs = shsub.add_parser("show", help="list the people on a line")
    shs.add_argument("number")
    sha = shsub.add_parser("add", help="add people to a line (making it shared if >1)")
    sha.add_argument("number")
    sha.add_argument("people", nargs="+")
    shr = shsub.add_parser("rm", help="remove people from a line")
    shr.add_argument("number")
    shr.add_argument("people", nargs="+")
    sh.set_defaults(fn=cmd_line)

    sub.add_parser("pull", help="write live Dynamo into people.yaml").set_defaults(fn=cmd_pull)
    sub.add_parser("sync", help="push people.yaml into live Dynamo (authoritative)").set_defaults(fn=cmd_sync)
    sub.add_parser("edit", help="pull, open $EDITOR, and commit edits back").set_defaults(fn=cmd_edit)

    c = sub.add_parser("calls")
    c.add_argument("--person", help="slug: everything discussed with this person")
    c.add_argument("--days", type=int, default=7)
    c.add_argument("--limit", type=int, default=25)
    c.set_defaults(fn=cmd_calls)

    cl = sub.add_parser("call")
    cl.add_argument("call_id")
    cl.set_defaults(fn=cmd_call)

    v = sub.add_parser("vapi")
    vsub = v.add_subparsers(dest="vcmd", required=True)
    vsub.add_parser("show").set_defaults(fn=cmd_vapi_show)
    s_ = vsub.add_parser("sync")
    s_.add_argument("--url")
    s_.add_argument("--secret")
    s_.add_argument("--fallback-number", help="defaults to fallbackNumber in local.json")
    s_.set_defaults(fn=cmd_vapi_sync)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()