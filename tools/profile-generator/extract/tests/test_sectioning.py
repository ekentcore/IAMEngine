"""Sectioner tests. Fixtures are synthetic but mirror real KB structure (the real
corpus in data/ is sensitive and gitignored, so it never becomes a committed fixture)."""
from kbgen.sectioning import normalize_header, split_sections


class TestNormalizeHeader:
    def test_lowercases_and_trims(self):
        assert normalize_header("  ServiceNow  ") == "servicenow"

    def test_strips_trailing_colon(self):
        assert normalize_header("ServiceNow:") == "servicenow"

    def test_strips_parentheticals(self):
        assert normalize_header("Tableau (If Requested)") == "tableau"
        assert normalize_header("Perimeter 81 (if requested)") == "perimeter 81"

    def test_strips_numeric_prefix(self):
        assert normalize_header("1. Microsoft 365") == "microsoft 365"
        assert normalize_header("2) Microsoft Entra") == "microsoft entra"

    def test_strips_step_prefix(self):
        assert normalize_header("Step 1: ServiceNow") == "servicenow"
        assert normalize_header("Step 2: Microsoft 365 — Entra Admin") == "microsoft 365 - entra admin"

    def test_normalizes_dash_but_keeps_both_sides(self):
        # The dash is preserved (normalized to ' - ') so the classifier can substring-match
        # the right side ('entra admin') OR the left ('active directory') as needed.
        assert normalize_header("Microsoft 365 — Entra Admin") == "microsoft 365 - entra admin"
        assert normalize_header("Active Directory - Yee (Little Rock)") == "active directory - yee"
        assert normalize_header("VPN/RDS - Perimeter 81") == "vpn/rds - perimeter 81"

    def test_does_not_alter_unspaced_hyphen_or_slash(self):
        assert normalize_header("G-Suite") == "g-suite"
        assert normalize_header("Hardware/Data") == "hardware/data"

    def test_collapses_internal_whitespace(self):
        assert normalize_header("Microsoft   365") == "microsoft 365"


class TestSplitSections:
    HTML = """
      <h2>Table of Contents</h2><ul><li>stuff</li></ul>
      <h2>ServiceNow</h2><p>Create the contact record.</p>
      <h2>Microsoft 365</h2>
        <p>Assign Microsoft 365 E3.</p>
        <h4>Teams (if requested)</h4><p>Phone by area code.</p>
      <h2>Domain Setup</h2><p>Create the AD user in the Users OU.</p>
    """

    def test_returns_sections_in_document_order(self):
        secs = split_sections(self.HTML)
        headers = [s.header for s in secs]
        assert headers == ["servicenow", "microsoft 365", "teams", "domain setup"]

    def test_excludes_table_of_contents_noise(self):
        secs = split_sections(self.HTML)
        assert "table of contents" not in [s.header for s in secs]

    def test_captures_section_body_text(self):
        secs = {s.header: s for s in split_sections(self.HTML)}
        assert "Microsoft 365 E3" in secs["microsoft 365"].text

    def test_body_text_stops_at_next_header(self):
        # The m365 section body must not bleed into the Domain Setup section.
        secs = {s.header: s for s in split_sections(self.HTML)}
        assert "AD user" not in secs["microsoft 365"].text

    def test_excludes_sentence_like_headers(self):
        # Embedded prose rendered as a heading (a known noise source) must be dropped.
        html = ("<h3>Artisan has its own tenant for the following locations</h3><p>x</p>"
                "<h2>Mimecast</h2><p>y</p>")
        assert [s.header for s in split_sections(html)] == ["mimecast"]

    def test_preserves_raw_header_and_level(self):
        secs = {s.header: s for s in split_sections(self.HTML)}
        assert secs["teams"].raw_header == "Teams (if requested)"
        assert secs["teams"].level == 4
