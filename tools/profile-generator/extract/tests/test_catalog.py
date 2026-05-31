from kbgen.catalog import classify_header
from kbgen.sectioning import normalize_header


def kind(h):
    return classify_header(h)[0]


def key(h):
    return classify_header(h)[1]


class TestClassifyHeader:
    def test_microsoft_365_variants_map_to_m365(self):
        for h in ["microsoft 365", "365 admin", "365 admin center", "o365", "admin center"]:
            assert classify_header(h) == ("system", "m365"), h

    def test_entra_wins_over_365(self):
        # 'entra admin' must classify as entra, not m365 (order in SECTION_ALIASES).
        assert classify_header("entra admin") == ("system", "entra")
        assert classify_header("microsoft entra") == ("system", "entra")
        assert classify_header("azure active directory") == ("system", "entra")

    def test_exchange(self):
        assert classify_header("exchange admin") == ("system", "exchange")
        assert classify_header("exchange admin center") == ("system", "exchange")

    def test_onprem_identity(self):
        assert classify_header("domain setup") == ("system", "active-directory")
        assert classify_header("domain") == ("system", "active-directory")
        assert classify_header("active directory") == ("system", "active-directory")
        assert classify_header("ad sync") == ("system", "directory-sync")

    def test_assorted_systems(self):
        assert classify_header("mimecast") == ("system", "mimecast")
        assert classify_header("g-suite") == ("system", "google-workspace")
        assert classify_header("spanning") == ("system", "spanning")
        assert classify_header("perimeter 81") == ("system", "perimeter81")
        assert classify_header("welcome letter / info email") == ("system", "welcome-letter")
        assert classify_header("first day steps") == ("system", "first-day-call")

    def test_unmodeled_known_vendor_carries_guess(self):
        assert classify_header("duo") == ("unmodeled", "Duo (MFA)")
        assert classify_header("salesforce") == ("unmodeled", "Salesforce")
        assert kind("lob applications") == "unmodeled"

    def test_unmodeled_unknown_has_no_guess(self):
        assert classify_header("frobnicator 9000") == ("unmodeled", None)

    def test_noise(self):
        assert classify_header("table of contents") == ("noise", None)


class TestClassifyDashedRealHeaders:
    """Regression: dashed headers from the real corpus, fed through normalize_header."""

    def c(self, raw):
        return classify_header(normalize_header(raw))

    def test_microsoft_365_dash_entra_admin_is_entra(self):
        assert self.c("Microsoft 365 — Entra Admin") == ("system", "entra")

    def test_microsoft_365_dash_exchange_admin_is_exchange(self):
        assert self.c("Microsoft 365 — Exchange Admin") == ("system", "exchange")

    def test_active_directory_dash_location_is_ad(self):
        assert self.c("Active Directory - Yee (Little Rock)") == ("system", "active-directory")

    def test_resolving_case_is_case_resolution(self):
        assert self.c("Resolving Case") == ("system", "case-resolution")

    def test_mailbox_audit_is_exchange(self):
        assert self.c("Mailbox Audit") == ("system", "exchange")
