from kbgen.loader import best_per_action


def rec(action, number, latest):
    return {"action": action, "number": number, "latest": latest, "client": "C"}


class TestBestPerAction:
    def test_prefers_latest_true(self):
        recs = [rec("onboarding", "OLD", False), rec("onboarding", "NEW", True)]
        picked = best_per_action(recs)
        assert [r["number"] for r in picked] == ["NEW"]

    def test_falls_back_to_available_when_none_latest(self):
        # ACORE case: the only onboarding record is latest=False — still use it.
        recs = [rec("onboarding", "KB0014408", False), rec("offboarding", "KB0014407", True)]
        picked = {r["action"]: r["number"] for r in best_per_action(recs)}
        assert picked == {"onboarding": "KB0014408", "offboarding": "KB0014407"}

    def test_only_offboarding(self):
        picked = best_per_action([rec("offboarding", "OFF", True)])
        assert [r["action"] for r in picked] == ["offboarding"]
