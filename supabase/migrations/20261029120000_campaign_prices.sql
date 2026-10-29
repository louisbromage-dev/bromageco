-- Campaign pricing for the public website (bromageco.com).
--
-- Kept apart from builder_packages on purpose: builder_packages is the price
-- list the Bromage Insight dashboard publishes, and campaign tiers need dates
-- and payment links it does not have. Rows here never appear in that list.
--
-- Dates are Europe/London calendar dates and inclusive: a tier runs from
-- 00:00:00 on active_from to 23:59:59 on active_until, London time. The
-- website works out the current tier in the visitor's browser.

create table public.campaign_prices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users (id),
  campaign      text not null,
  kind          text not null check (kind in ('tier', 'addon')),
  key           text not null check (key ~ '^[a-z0-9-]+$'),
  label         text not null,
  price         numeric(10, 2) check (price is null or price >= 0),
  -- fixed: the price as shown; plus_tier: added to the current tier's price;
  -- quote: priced individually (price is null)
  price_basis   text not null default 'fixed' check (price_basis in ('fixed', 'plus_tier', 'quote')),
  active_from   date,
  active_until  date,
  -- Live Stripe Payment Link. Null means the tier is booked by phone.
  payment_link  text check (payment_link is null or payment_link ~ '^https://book\.stripe\.com/[A-Za-z0-9]+$'),
  sort_order    integer not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (campaign, key),
  check (kind <> 'tier' or (price is not null and active_from is not null and active_until is not null and active_until >= active_from)),
  check ((price_basis = 'quote') = (price is null))
);

comment on table public.campaign_prices is
  'Time-limited website campaign prices (for example Self Assessment 2025/26). Public read of active rows; dates are inclusive Europe/London calendar dates.';
comment on column public.campaign_prices.active_from is 'First day the tier applies, Europe/London.';
comment on column public.campaign_prices.active_until is 'Last day the tier applies (until 23:59:59), Europe/London.';

create trigger update_campaign_prices_updated_at
  before update on public.campaign_prices
  for each row execute function update_updated_at_column();

-- Same exposure as builder_packages: anyone can read active rows; only the
-- owner can change them.
alter table public.campaign_prices enable row level security;

create policy "Public can read active campaign prices"
  on public.campaign_prices for select
  to anon, authenticated
  using (active = true);

create policy "Users can view own campaign prices"
  on public.campaign_prices for select
  using (auth.uid() = user_id);

create policy "Users can insert own campaign prices"
  on public.campaign_prices for insert
  with check (auth.uid() = user_id);

create policy "Users can update own campaign prices"
  on public.campaign_prices for update
  using (auth.uid() = user_id);

create policy "Users can delete own campaign prices"
  on public.campaign_prices for delete
  using (auth.uid() = user_id);

-- Self Assessment 2025/26, from the campaign handover.
insert into public.campaign_prices
  (user_id, campaign, kind, key, label, price, price_basis, active_from, active_until, payment_link, sort_order)
values
  ('17713ad0-ae7a-4880-b53e-abdf83894922', 'sa-2025-26', 'tier', 'november', 'Early bird', 180, 'fixed', '2026-10-29', '2026-11-30', 'https://book.stripe.com/aFabIU08T0k99XTglk1wY00', 1),
  ('17713ad0-ae7a-4880-b53e-abdf83894922', 'sa-2025-26', 'tier', 'december', 'December', 230, 'fixed', '2026-12-01', '2026-12-31', 'https://book.stripe.com/dRm8wI6xh0k92vrc541wY01', 2),
  ('17713ad0-ae7a-4880-b53e-abdf83894922', 'sa-2025-26', 'tier', 'january', 'Standard fee', 300, 'fixed', '2027-01-01', '2027-01-20', 'https://book.stripe.com/7sY5kwf3N9UJ4Dz5GG1wY02', 3),
  ('17713ad0-ae7a-4880-b53e-abdf83894922', 'sa-2025-26', 'tier', 'closed', 'By phone, subject to capacity', 350, 'fixed', '2027-01-21', '2027-01-31', null, 4),
  ('17713ad0-ae7a-4880-b53e-abdf83894922', 'sa-2025-26', 'addon', 'partner', 'Spouse or partner return', 150, 'fixed', null, null, null, 10),
  ('17713ad0-ae7a-4880-b53e-abdf83894922', 'sa-2025-26', 'addon', 'income-100k-200k', 'Income £100,000 to £200,000, including a short tax-saving review', 100, 'plus_tier', null, null, null, 11),
  ('17713ad0-ae7a-4880-b53e-abdf83894922', 'sa-2025-26', 'addon', 'income-over-200k', 'Income over £200,000', null, 'quote', null, null, null, 12);
