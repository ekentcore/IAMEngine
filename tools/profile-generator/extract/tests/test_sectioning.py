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


class TestSectionSteps:
    HTML = """
      <h2>Microsoft 365</h2>
      <p>Connect to Entra Admin Center.</p>
      <ol>
        <li>Click New user
          <ul><li>Username: FLast@x.com</li><li>Set a password</li></ul>
        </li>
        <li>Fill the properties tab</li>
      </ol>
      <h2>Mimecast</h2><p>Sync the directory.</p>
    """

    def test_paragraph_and_list_items_become_ordered_steps(self):
        m = {s.header: s for s in split_sections(self.HTML)}["microsoft 365"]
        joined = " || ".join(m.steps)
        assert m.steps[0] == "Connect to Entra Admin Center."
        assert "Click New user" in joined
        assert "Username: FLast@x.com" in joined
        assert "Fill the properties tab" in joined

    def test_parent_li_excludes_nested_list_text(self):
        m = {s.header: s for s in split_sections(self.HTML)}["microsoft 365"]
        parent = next(s for s in m.steps if "Click New user" in s)
        assert "Username" not in parent  # nested items are their own steps

    def test_nested_steps_are_indented(self):
        m = {s.header: s for s in split_sections(self.HTML)}["microsoft 365"]
        nested = next(s for s in m.steps if "Username: FLast@x.com" in s)
        assert nested.startswith("  ")

    def test_steps_do_not_bleed_into_next_section(self):
        m = {s.header: s for s in split_sections(self.HTML)}["microsoft 365"]
        assert all("Sync the directory" not in s for s in m.steps)


class TestStepSection:
    """Real KB authors verify/confirm steps as
       <div class="step-section"><span>INSTRUCTION</span>
         <div class="step"><ul><li>ITEM</li>…</ul></div></div>
    The instruction span lives outside any <li>/<p>, so it was being dropped while the
    group items showed with no context. Capture the instruction as a step with the items
    nested under it."""

    HTML = """
      <h2>Microsoft Entra</h2>
      <div class="step-section">
        <span>Verify the user was added to the following dynamic groups:</span>
        <div class="step">
          <ul><li>AAD-KnowBe4</li><li>AAD-MFA-Enabled</li></ul>
        </div>
      </div>
      <h2>Mimecast</h2><p>Sync the directory.</p>
    """

    def _entra(self):
        return {s.header: s for s in split_sections(self.HTML)}["microsoft entra"]

    def test_instruction_span_becomes_a_step(self):
        steps = self._entra().steps
        assert any(s.strip() == "Verify the user was added to the following dynamic groups:" for s in steps)

    def test_group_list_items_captured(self):
        joined = " || ".join(self._entra().steps)
        assert "AAD-KnowBe4" in joined and "AAD-MFA-Enabled" in joined

    def test_group_items_nested_under_instruction(self):
        steps = self._entra().steps
        instr = next(i for i, s in enumerate(steps) if "Verify the user" in s)
        group = next(i for i, s in enumerate(steps) if "AAD-KnowBe4" in s)
        assert instr < group                       # instruction first
        assert not steps[instr].startswith(" ")    # at depth 0
        assert steps[group].startswith("  ")       # items indented as sub-steps

    def test_instruction_excludes_the_group_list_text(self):
        instr = next(s for s in self._entra().steps if "Verify the user" in s)
        assert "AAD-KnowBe4" not in instr  # the nested list wrapper is excluded from own text

    def test_step_section_steps_do_not_bleed_into_next_section(self):
        assert all("Sync the directory" not in s for s in self._entra().steps)
