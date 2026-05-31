from kbgen.registry import extract_signals
from kbgen.sectioning import Section


def sec(raw, text, level=2):
    from kbgen.sectioning import normalize_header
    return Section(raw, normalize_header(raw), level, text)


class TestWhen:
    def test_if_requested_header_is_on_request(self):
        assert extract_signals("teams", sec("Teams (if requested)", "phone")).get("when") == "on-request"

    def test_plain_header_is_always(self):
        assert extract_signals("m365", sec("Microsoft 365", "stuff")).get("when") == "always"


class TestM365Licenses:
    def test_extracts_known_licenses_in_order_deduped(self):
        text = ("Assign Microsoft 365 E3 and Microsoft Entra ID P2. "
                "Also add Microsoft Teams Phone Standard and Microsoft 365 E3 again.")
        sig = extract_signals("m365", sec("Microsoft 365", text))
        assert sig["licenses"] == ["Microsoft 365 E3", "Microsoft Entra ID P2", "Microsoft Teams Phone Standard"]

    def test_no_licenses_yields_no_key(self):
        sig = extract_signals("m365", sec("Microsoft 365", "Create the mailbox."))
        assert "licenses" not in sig


class TestActiveDirectory:
    def test_extracts_quoted_ou(self):
        sig = extract_signals("active-directory", sec("Domain", "Create the user in the 'Six One Users' OU."))
        assert sig.get("ou") == "Six One Users"

    def test_extracts_unquoted_ou_without_leading_prose(self):
        sig = extract_signals("active-directory", sec("Domain", "Create the user in the Six One Users OU."))
        assert sig.get("ou") == "Six One Users"

    def test_no_clean_ou_yields_no_ou(self):
        # 'their OU' has no capitalised name before it -> better to omit than capture garbage.
        sig = extract_signals("active-directory", sec("Domain", "Do not move the user outside of their OU."))
        assert "ou" not in sig

    def test_detects_do_not_move_ou_guardrail(self):
        sig = extract_signals("active-directory", sec("Domain", "Do NOT move the user out of their OU — it deletes the user in 365."))
        assert "do-not-move-ou" in sig.get("guardrails", [])


class TestSchedule:
    def test_after_n_days_becomes_schedule(self):
        sig = extract_signals("archive", sec("Archive", "Archive the mailbox after 30 days."))
        assert sig["schedule"]["offsetDaysMin"] == 30
