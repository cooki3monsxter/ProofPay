"""Builds postman/ProofPay.postman_collection.json from the OpenAPI spec (run: npm run postman)."""
import json, subprocess, sys, os, tempfile
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
raw = os.path.join(tempfile.mkdtemp(), "raw.json")
subprocess.run(["npx", "-y", "openapi-to-postmanv2@4", "-s", os.path.join(root, "apimatic/src/spec/openapi.yaml"), "-o", raw, "-p",
                "-O", "folderStrategy=Tags,requestParametersResolution=Example,exampleParametersResolution=Example"], check=True, capture_output=True)
c = json.load(open(raw))
c["info"]["name"] = "ProofPay API"
c["info"]["description"] = ("Pay-on-proof escrow on PayPal. Generated from apimatic/src/spec/openapi.yaml.\n\n"
  "1. Set baseUrl (default http://localhost:8080).\n"
  "2. Run \"Escrows → Create escrow from scope\". It saves clientKey, freelancerKey, escrowId and milestoneId.\n"
  "3. Requests send {{escrowKey}} as a bearer token. Set it to {{clientKey}}, {{freelancerKey}} or {{adminKey}} to act as that party.")
c["variable"] = [{"key": k, "value": v} for k, v in [("baseUrl", "http://localhost:8080"), ("escrowKey", ""), ("clientKey", ""),
  ("freelancerKey", ""), ("adminKey", ""), ("escrowId", ""), ("milestoneId", "")]]
c["auth"] = {"type": "bearer", "bearer": [{"key": "token", "value": "{{escrowKey}}", "type": "string"}]}
save = ["if (pm.response.code === 201) {", "  const j = pm.response.json();",
  "  pm.collectionVariables.set('clientKey', j.access.clientKey || '');",
  "  pm.collectionVariables.set('freelancerKey', j.access.freelancerKey || '');",
  "  pm.collectionVariables.set('escrowId', j.escrow.id);",
  "  pm.collectionVariables.set('milestoneId', j.escrow.milestones[0].id);",
  "  pm.collectionVariables.set('escrowKey', j.access.clientKey || j.access.agentKey);", "}",
  "pm.test('created', () => pm.response.to.have.status(201));"]
def walk(items):
    for it in items:
        if "item" in it: walk(it["item"]); continue
        url = it["request"].get("url", {})
        for v in (url.get("variable") or []) if isinstance(url, dict) else []:
            if v["key"] in ("escrowId", "milestoneId"): v["value"] = "{{%s}}" % v["key"]
        path = "/".join(url.get("path", [])) if isinstance(url, dict) else str(url)
        if path.endswith("escrows/from-scope"):
            it["name"] = "Create escrow from scope"
            it["event"] = [{"listen": "test", "script": {"type": "text/javascript", "exec": save}}]
            it["request"]["body"]["raw"] = json.dumps({"scopeText": "Checkout redesign\nMilestone 1: Landing page - $300, due in 7 days. Live at a public URL.",
              "currency": "USD", "client": {"name": "Asha", "email": "asha@example.com"}, "freelancer": {"name": "Dev", "email": "dev@example.com"}}, indent=2)
walk(c["item"])
out = os.path.join(root, "postman", "ProofPay.postman_collection.json")
json.dump(c, open(out, "w"), indent=2)
n = lambda items: sum(n(i["item"]) if "item" in i else 1 for i in items)
print(f"wrote {out} ({n(c['item'])} requests)")
