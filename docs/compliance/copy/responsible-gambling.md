# Diamond Edge — Responsible Gambling Copy v1

**Status:** Draft — ATTORNEY REVIEW REQUIRED before publishing
**Date:** 2026-04-22
**Author:** mlb-compliance
**Note:** All copy below is a draft. A licensed attorney and, ideally, a responsible gambling professional must review before any version goes live. These are substantive, not boilerplate — the goal is to actually help someone who needs help.

---

## National Resources (cite on all surfaces)

- **National Problem Gambling Helpline:** 1-800-522-4700 (call or text, 24/7)
- **Chat:** ncpgambling.org/chat
- **Crisis Text Line:** Text HOME to 741741
- **State-specific lines:** The frontend can inject the state-specific hotline based on the user's declared state. A list of state-specific hotlines is maintained by NCPG at ncpgambling.org/help-treatment/helplines/.

---

## Surface 1: Picks Page Header/Footer Disclaimer

**Placement:** Sticky footer on all pick-listing pages and pick detail pages. Also as a slim banner at the top of the picks slate.

**Character limit target:** Under 200 characters for the shortest version; longer version acceptable in footer.

### Short version (slim banner):
> Diamond Edge provides information only — not financial advice. If gambling affects your life, call 1-800-522-4700.

### Footer version:
> Diamond Edge is an information and analysis service. We do not place bets or hold funds. Sports betting involves real financial risk. Past pick performance does not guarantee future results. If you or someone you know is struggling with problem gambling, free, confidential help is available 24/7 at 1-800-522-4700 or ncpgambling.org.

---

## Surface 2: Subscription Sign-Up Page Disclaimer

**Placement:** Directly above the payment form, clearly visible before the user enters card info. Not hidden in small print.

### Copy:
> **Before you subscribe:**
>
> Diamond Edge provides statistical analysis and AI-generated rationale to help you evaluate MLB betting markets. We do not guarantee wins, profits, or any specific outcome. Sports betting is inherently uncertain — even high-confidence picks lose.
>
> A subscription to Diamond Edge is an investment in information, not in returns. Never bet more than you can afford to lose.
>
> If gambling is creating financial stress, relationship problems, or other harm in your life, please reach out before subscribing:
> - **National Problem Gambling Helpline:** 1-800-522-4700 (24/7, free, confidential)
> - **Online chat:** ncpgambling.org/chat
>
> Gambling should be entertainment. If it stops feeling that way, help is available.

---

## Surface 3: Onboarding Flow — Responsible Gambling Acknowledgment Step

**Placement:** Step 3 of onboarding (after email verification, after age gate). Required checkbox — user cannot proceed without checking it.

**Page title:** "A few things to know before you start"

### Copy:

> **Play within your limits.**
>
> Diamond Edge uses statistics and AI to identify edges in MLB betting markets. Our picks are grounded in data, but no model is perfect — variance is real, and losing streaks happen even when the edge is genuine.
>
> Before you use Diamond Edge picks, we ask you to commit to a few principles:
>
> - [ ] I will only bet money I can afford to lose.
> - [ ] I understand that Diamond Edge provides analysis, not guaranteed outcomes.
> - [ ] I will set a bankroll limit and stick to it. The bankroll tracker in my account is here to help.
> - [ ] If gambling stops feeling like fun, I will take a break and seek help if needed.
>
> **If you or someone you know needs support:**
> National Problem Gambling Helpline: 1-800-522-4700 (24/7, free, confidential)
> Text "HELP" to 233459 | ncpgambling.org/chat

*(All four checkboxes required to proceed.)*

---

## Surface 4: Site-Wide Footer

**Placement:** Global footer — every page, every session. Always visible.

### Copy:
> Diamond Edge is an information service. We do not place bets or hold funds on your behalf. 21+ only. Available only where DraftKings and FanDuel legally operate. Problem gambling? Call 1-800-522-4700. | [Terms of Service] | [Privacy Policy] | [Responsible Gambling]

---

## Surface 5: Pick Detail Page Sidebar

**Placement:** Sidebar or below-the-fold section on individual pick detail pages. Appears alongside the pick card.

### Copy:

> **A note on risk**
>
> This pick is based on a statistical model and AI analysis. The model identified an edge at the time of generation. Edges erode, lines move, and results vary.
>
> - Past performance does not predict future results.
> - This is analysis, not a guarantee.
> - Never bet more than your stated bankroll limit.
>
> Struggling with gambling? 1-800-522-4700 | ncpgambling.org

---

## State-Specific Hotlines (Frontend Injection Guide)

The frontend should detect the user's declared state (`profiles.geo_state`) and, if a state-specific helpline exists, append it below the national number. The NCPG maintains a full list at ncpgambling.org/help-treatment/helplines/.

Key states in our ALLOW list with dedicated lines:
- **NY:** 1-877-8-HOPENY (467-369) | text HOPENY to 467369
- **NJ:** 1-800-GAMBLER (426-2537)
- **PA:** 1-800-GAMBLER
- **OH:** 1-800-589-9966
- **MI:** 1-800-270-7117
- **IL:** 1-800-GAMBLER
- **CO:** 1-800-522-4700 (national line; CO also has cogambling.com)
- **MA:** 1-800-327-5050

For all other ALLOW states, default to the national line: 1-800-522-4700.

---

## Attorney-Review Items

- [ ] Confirm that the onboarding acknowledgment checkbox structure meets any state-specific disclosure requirements.
- [ ] Confirm that the subscription page disclaimer is legally sufficient in all 25 ALLOW jurisdictions.
- [ ] Review the "before you subscribe" language for any inadvertent warranty or guarantee claims.
- [ ] Confirm that the footer disclaimer ("21+ only, where DK and FD legally operate") is sufficient legal notice.
- [ ] Check whether any ALLOW state requires the state-specific hotline to appear (not just be available for injection).
- [ ] Review whether "Diamond Edge is an information service" language needs to be more specific in any jurisdiction (e.g., "not a licensed sportsbook, not a licensed handicapping service").
