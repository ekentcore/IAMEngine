from kbgen.build import build_client_ir


def rec(action, number, client, html):
    leaf = client.split("/")[-1]
    return {"action": action, "number": number, "client": client, "client_leaf": leaf,
            "domain_raw": "TOP/" + client, "latest": True, "body_html": html}


ONB = """
  <h2>ServiceNow</h2><p>Create contact with email jane@acme.com.</p>
  <h2>Microsoft 365</h2><p>Assign Microsoft 365 E3. Mailbox jane@acme.com.</p>
  <h2>Domain</h2><p>Create the user in the 'Acme Users' OU.</p>
  <h2>Mimecast</h2><p>Sync the user.</p>
  <h2>Duo</h2><p>Enroll the user in Duo MFA.</p>
"""


class TestBuildClientIr:
    def setup_method(self):
        self.ir = build_client_ir([rec("onboarding", "KB1", "Acme Holdings", ONB)])

    def test_irversion_and_client(self):
        assert self.ir["irVersion"] == "1.0"
        assert self.ir["client"]["leaf"] == "Acme Holdings"
        assert self.ir["client"]["suggestedId"] == "acme-holdings"

    def test_detected_systems_carry_keys(self):
        keys = {d["systemKey"] for d in self.ir["detected"]}
        assert {"servicenow", "m365", "active-directory", "mimecast"} <= keys

    def test_m365_signals_include_licenses(self):
        m = next(d for d in self.ir["detected"] if d["systemKey"] == "m365")
        assert m["signals"]["licenses"] == ["Microsoft 365 E3"]
        assert m["mode"] == "api"

    def test_backbone_hint_is_ad_synced_when_domain_present(self):
        assert self.ir["backboneHint"] == "ad-synced"

    def test_unmodeled_duo_reported_with_guess(self):
        duo = next(u for u in self.ir["unmodeled"] if u["guess"] == "Duo (MFA)")
        assert duo["action"] == "onboarding"

    def test_primary_domain_inferred_from_emails(self):
        assert self.ir["client"]["primaryDomain"] == "acme.com"

    def test_kb_numbers_recorded(self):
        assert self.ir["kb"]["onboard"] == "KB1"

    def test_confidence_in_unit_range(self):
        for d in self.ir["detected"]:
            assert 0.0 <= d["confidence"] <= 1.0
