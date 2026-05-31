from kbgen.families import detect_family, suggest_id
from kbgen.backbone import infer_backbone


class TestDetectFamily:
    def test_cvp_nested_path(self):
        assert detect_family("Community Veterinary Partners/Greenfields Veterinary Associates") == "cvp"

    def test_olympus(self):
        assert detect_family("Olympus Cosmetic") == "olympus"

    def test_standalone_client_has_no_family(self):
        assert detect_family("Six One Commodities LLC") is None

    def test_olympus_substring_in_unrelated_client_not_matched(self):
        # families are path PREFIXES, not substrings — 'Mt Olympus Imaging' is not Olympus.
        assert detect_family("Mt Olympus Imaging") is None


class TestSuggestId:
    def test_kebab_cases_leaf(self):
        assert suggest_id("Six One Commodities LLC") == "six-one-commodities-llc"

    def test_strips_punctuation(self):
        assert suggest_id(".406 Ventures") == "406-ventures"

    def test_uses_leaf_for_nested(self):
        assert suggest_id("Greenfields Veterinary Associates") == "greenfields-veterinary-associates"

    def test_truncates_to_40_chars_like_roster_slug(self):
        # Must match web/lib/clients/sync-service.ts deriveSlug (.slice(0,40)) so generated
        # ids line up with the ServiceNow roster slugs.
        long_name = "A Very Long Client Organization Name That Exceeds Forty Characters LLC"
        assert len(suggest_id(long_name)) <= 40


class TestInferBackbone:
    def test_directory_sync_means_ad_synced(self):
        assert infer_backbone({"m365", "active-directory", "directory-sync"}) == "ad-synced"

    def test_ad_without_explicit_sync_defaults_ad_synced(self):
        # Six One's runbook shows only 'Domain' (-> active-directory), yet it is ad-synced.
        assert infer_backbone({"servicenow", "m365", "active-directory"}) == "ad-synced"

    def test_google_workspace_means_google(self):
        assert infer_backbone({"servicenow", "google-workspace", "mimecast"}) == "google"

    def test_cloud_only_means_entra(self):
        assert infer_backbone({"servicenow", "m365", "entra", "exchange"}) == "entra"

    def test_unknown_is_none(self):
        assert infer_backbone({"servicenow"}) is None
