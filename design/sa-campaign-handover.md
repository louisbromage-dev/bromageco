# Handover: Self Assessment campaign on bromageco.com

**For:** Claude Code
**From:** Louis Bromage, Bromage & Co Accounting Ltd
**Repo:** louisbromage-dev/bromageco (deployed on Vercel)
**Design input:** the HTML from Claude Design, dropped into this repo alongside this file

## 1. What you're doing

Build the Self Assessment 2025/26 campaign into the live site, using the Claude Design HTML as the visual reference. The campaign runs from now until 31 January 2027.

Three pieces:

1. **Site-wide top banner** promoting the current price
2. **Homepage campaign card** in the empty space above the Services list (top right of the hero)
3. **Campaign landing page** at `/tax-return`, plus a thank-you page at `/tax-return/thank-you`

Before writing code, inspect the repo to see how the site is built (framework, components, styling) and implement the design using the site's existing conventions. Don't paste the design HTML in as a standalone blob. Match the existing look exactly: warm off-white background, serif headings with italic accents, sans-serif body, dark green accent, thin rules, generous white space.

## 2. Campaign config: one source of truth

Put all prices, dates and links in a single config object (for example `src/config/saCampaign.ts` or the equivalent for this stack). Nothing about the campaign should be hard-coded anywhere else.

All dates are **Europe/London**. Each tier ends at 23:59:59 London time on its end date.

| Tier | Active from | Active until | Price | Live Stripe payment link |
| --- | --- | --- | --- | --- |
| November (early bird) | now | 30 Nov 2026 | £180 | https://book.stripe.com/aFabIU08T0k99XTglk1wY00 |
| December | 1 Dec 2026 | 31 Dec 2026 | £230 | https://book.stripe.com/dRm8wI6xh0k92vrc541wY01 |
| January (standard) | 1 Jan 2027 | 20 Jan 2027 | £300 | https://book.stripe.com/7sY5kwf3N9UJ4Dz5GG1wY02 |
| Closed, late bookings by phone | 21 Jan 2027 | 31 Jan 2027 | £350, subject to capacity | none: show phone number 07387 835 746 |
| Campaign over | 1 Feb 2027 | | | hide banner and card |

Other fixed values:

- Standard fee: £300 (used for "Normally £300")
- Spouse or partner return: £150 at any tier (already an optional add-on inside each Stripe checkout)
- Income £100,000 to £200,000: tier price plus £100. Over £200,000: quoted individually.
- Phone: 07387 835 746. Email: enquiries@bromageco.com
- Fixed fee, no VAT (the company is not VAT registered)

**Important:** work out the current tier at runtime in the visitor's browser (or at the edge), not at build time. The site is static and cached, so a build-time calculation would show expired prices until the next deploy. Make sure the server-rendered default doesn't flash the wrong price before hydration.

Add a way to preview every state, for example a `?saPreview=december` query parameter that only works on preview deployments, so Louis can check each tier before it happens.

## 3. Stripe links

- Use only the **live** links above. Never commit test links (`book.stripe.com/test_...`).
- No Stripe keys, secrets or payment code go in this repo. The links handle everything.
- Append `?client_reference_id=<source>` to each link so Louis can see in Stripe where bookings came from. Use: `banner`, `home-card`, `tax-return-hero`, `tax-return-pricing`, `tax-return-footer`. Letters, numbers, hyphens and underscores only.

## 4. The three pieces

### Top banner (every page)

- Replaces the current rebrand message ("Fileo & Co Accounting is now Bromage & Co...") while the campaign runs.
- Text follows the tier, for example: "Self Assessment 2025/26: £180 if you book by 30 November →", linking to `/tax-return`.
- Closed state (21 to 31 January): "Online bookings have closed. Call 07387 835 746 to check if we have capacity."
- Dismissible. Store the dismissal per tier (for example `sa-banner-dismissed-november`) so it reappears when the price changes. Wrap storage access in try/catch.
- From 1 February 2027, restore the original rebrand message.

### Homepage card

- Sits in the empty area above the Services list, aligned to that column's width. This space will later hold a photo of Louis, so the card must be removable by deleting one component, with no layout breakage.
- Content follows the design and the config: label "Self Assessment 2025/26", heading with the current price, deadline line, "Normally £300. Fixed fee, no VAT.", the later tier prices, a quiet "X days left at £180" line, and a "Book my tax return" button in the existing dark green style linking to the current Stripe link.
- On mobile it sits below the hero text and above the Services list.
- Hidden from 1 February 2027.

### `/tax-return` page

Follow the Claude Design layout. If anything is missing from the design, use this order:

1. Hero: current price, deadline, one-line promise, Book button, phone number
2. Price table: all tiers, current one highlighted, past ones shown as ended
3. What's included: employment and pension income, bank interest, dividends, one rental property, High Income Child Benefit Charge, pension and Gift Aid relief
4. Extras: self-employment or CIS income, additional properties, capital gains, foreign income, partner returns (£150), the over-£100,000 band
5. Why file early: file online by 30 December and, if you owe £3,000 or less and already pay tax through PAYE, HMRC can usually collect it through your tax code. The 2025/26 return also decides whether Making Tax Digital applies to sole traders and landlords (over £30,000 qualifying income) from April 2027.
6. How it works: book and pay, Louis calls within one working day, quick ID check, send records, approve the draft, we file
7. About Louis: principal-led, ACMA CGMA, Chartered Management Accountant, Army veteran, local. Photo placeholder.
8. FAQs: what counts as complete records; what happens if my records are late (the price moves to the next tier); do I need a UTR; what if my return is more complex; what if you can't take me on (refunded in full)
9. Final call to action with Book button and phone number

Page title: "Self Assessment tax return from £180 | Bromage & Co". Write a meta description that follows the current tier. The page should be indexable.

### `/tax-return/thank-you` page

- Message: "Thank you for booking. Louis will call you within one working day to take you through onboarding: a quick ID check and the list of records we need." Plus phone and email.
- This is where the Google Ads conversion tag will fire. Leave a clearly marked placeholder for the conversion snippet; Louis will supply the tag.
- Set it to `noindex`.
- The Stripe links currently show Stripe's own confirmation page. Once this page is live on production, tell Louis, so the payment links can be switched to redirect here.

## 5. Rules

- No pop-ups, modals or anything that blocks the page.
- No stock photos.
- Calm, confident tone: no exclamation marks, no flashing or animated countdowns, no "limited time only" language.
- **No em dashes anywhere in the copy.**
- Describe Louis as a Chartered Management Accountant (ACMA CGMA). Do not use the phrase "chartered accountant"; also change the existing homepage line "Chartered accountant in Fleet, Hampshire" to "Chartered Management Accountant in Fleet, Hampshire".
- Accessibility: readable contrast, visible focus states, real buttons and links, labelled elements, banner dismiss button with an accessible name.
- Don't change other pages or sections beyond the banner and the homepage line above.

## 6. Before handing back

- Check every state using the preview parameter: November, December, January, closed, campaign over.
- Check the date boundaries (30 November 23:59 vs 1 December 00:00, London time).
- Check mobile at 375px wide and desktop.
- Click through every Book button to confirm it reaches the right live Stripe link with the right `client_reference_id`.
- Deploy to a **Vercel preview** and give Louis the preview link. Do not deploy to production until Louis approves.
