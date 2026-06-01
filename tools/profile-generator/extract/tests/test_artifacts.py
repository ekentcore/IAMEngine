"""Artifact-extractor tests. The fixture mirrors the real LogicSource 'OneMarket Apps'
email template (the corpus in data/ is sensitive + gitignored, so never a committed
fixture). Structure: a step-section with intro <p>s, a 'CC …' <li>, 'Email:' <div>s with
mailto anchors, a 'Subject:' line, and a <pre> body with Label: fill-in fields."""
from kbgen.extractors.artifacts import extract_artifacts, extract_email

ONEMARKET_HTML = """
<div class="step-section">
  <div class="step scrollable">
    <div><p><span>Email the two addresses below with the new user's information.</span></p></div>
    <div><p><span>Use the email template below and edit as necessary for the new user.</span></p></div>
    <ul><li><p><span>CC Scotty Forrest and <a href="mailto:help&#64;core.tech">help&#64;core.tech</a> with the case number in the subject</span></p></li></ul>
    <div><span>Email: <a href="mailto:helpdesk&#64;logicsource.com">helpdesk&#64;logicsource.com</a></span><br/><span>For: Insights, P2P</span></div>
    <div><span>Email: <a href="mailto:s2chelp&#64;logicsource.com">s2chelp&#64;logicsource.com</a></span></div>
    <div><span>Subject: New User Activation: OneMarket Apps</span></div>
    <pre><span>Good morning/afternoon LogicSource Helpdesk,

Please grant access to (software) for the following user:

Name:
Title:
Department:
Location:
Reports to:
Start Date:
Personal Email:
Work Email:

Thank you,</span></pre>
  </div>
</div>
"""


class TestExtractEmail:
    def _email(self):
        return extract_email(ONEMARKET_HTML)

    def test_detects_an_email_artifact(self):
        e = self._email()
        assert e is not None and e["type"] == "email"

    def test_to_addresses_are_the_email_lines(self):
        e = self._email()
        assert e["to"] == ["helpdesk@logicsource.com", "s2chelp@logicsource.com"]

    def test_cc_includes_the_coretelligent_address_not_the_to_lines(self):
        e = self._email()
        assert "help@core.tech" in e["cc"]
        assert "helpdesk@logicsource.com" not in e["cc"]

    def test_cc_includes_the_named_recipient(self):
        e = self._email()
        assert "Scotty Forrest" in e["cc"]

    def test_subject_is_parsed(self):
        assert self._email()["subject"] == "New User Activation: OneMarket Apps"

    def test_body_is_the_pre_template(self):
        body = self._email()["body"]
        assert "Good morning/afternoon LogicSource Helpdesk," in body
        assert "Please grant access to (software)" in body
        assert "Name:" in body  # newlines preserved -> fields on their own lines

    def test_fields_are_the_fill_in_labels(self):
        fields = self._email()["fields"]
        assert fields == ["Name", "Title", "Department", "Location",
                          "Reports to", "Start Date", "Personal Email", "Work Email"]

    def test_non_email_section_returns_none(self):
        assert extract_email("<div class='step'><ul><li>Sync the directory</li></ul></div>") is None


class TestExtractArtifacts:
    def test_returns_the_email_artifact_for_a_template_section(self):
        arts = extract_artifacts(ONEMARKET_HTML)
        assert len(arts) == 1 and arts[0]["type"] == "email"

    def test_empty_for_a_plain_section(self):
        assert extract_artifacts("<p>Assign Microsoft 365 E3.</p>") == []
