-- Insights: short weekly notes on the public website (bromageco.com/insights),
-- and the key dates shown beside them.
--
-- The website reads both tables with the public anon key. Visitors see a post
-- once is_published is true and published_at has passed, so a post can be
-- written ahead and scheduled for a Tuesday. Only the owner can change rows.

create table public.insights (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users (id),
  slug          text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title         text not null check (length(title) between 1 and 160),
  -- One or two sentences: the list, the meta description and link previews.
  summary       text not null check (length(summary) between 1 and 320),
  -- Markdown.
  body          text not null default '',
  category      text not null check (category in ('Tax', 'Rates & Money', 'Deadlines', 'Rules & Regulation')),
  published_at  timestamptz,
  updated_at    timestamptz not null default now(),
  is_published  boolean not null default false,
  created_at    timestamptz not null default now(),
  check (not is_published or published_at is not null)
);

comment on table public.insights is
  'Weekly notes for bromageco.com/insights. Public read of published rows whose published_at has passed; body is markdown.';
comment on column public.insights.slug is 'The address: bromageco.com/insights/<slug>/. Lowercase words joined by hyphens.';
comment on column public.insights.published_at is 'Shown as the post date. A published post with a future date appears at that time.';
comment on column public.insights.updated_at is 'Set automatically on every edit. The site shows "Updated" when this falls on a later day than published_at.';

create index insights_published_idx on public.insights (published_at desc) where is_published;

create trigger update_insights_updated_at
  before update on public.insights
  for each row execute function update_updated_at_column();

alter table public.insights enable row level security;

create policy "Public can read published insights"
  on public.insights for select
  to anon, authenticated
  using (is_published = true and published_at <= now());

create policy "Users can view own insights"
  on public.insights for select
  using (auth.uid() = user_id);

create policy "Users can insert own insights"
  on public.insights for insert
  with check (auth.uid() = user_id);

create policy "Users can update own insights"
  on public.insights for update
  using (auth.uid() = user_id);

create policy "Users can delete own insights"
  on public.insights for delete
  using (auth.uid() = user_id);


create table public.key_dates (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users (id),
  label        text not null,
  -- Europe/London calendar date. The site shows only dates from today on.
  date         date not null,
  description  text not null default '',
  -- Who it applies to, for example 'Sole traders, Landlords'.
  audience     text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.key_dates is
  'Tax and filing dates shown on bromageco.com/insights. Public read; the site shows the next few upcoming dates.';

create index key_dates_date_idx on public.key_dates (date);

create trigger update_key_dates_updated_at
  before update on public.key_dates
  for each row execute function update_updated_at_column();

alter table public.key_dates enable row level security;

create policy "Public can read key dates"
  on public.key_dates for select
  to anon, authenticated
  using (true);

create policy "Users can view own key dates"
  on public.key_dates for select
  using (auth.uid() = user_id);

create policy "Users can insert own key dates"
  on public.key_dates for insert
  with check (auth.uid() = user_id);

create policy "Users can update own key dates"
  on public.key_dates for update
  using (auth.uid() = user_id);

create policy "Users can delete own key dates"
  on public.key_dates for delete
  using (auth.uid() = user_id);


-- A placeholder post, not published, to show the format.
insert into public.insights (user_id, slug, title, summary, body, category, is_published)
values (
  '17713ad0-ae7a-4880-b53e-abdf83894922',
  'placeholder-first-insight',
  'Placeholder: your first insight goes here',
  'One or two sentences on what changed and who it affects. This appears in the list, in search results and when the link is shared.',
  E'Start with what has changed, in a sentence or two.\n\n## What it means for you\n\nExplain the effect in plain terms. Short paragraphs work best.\n\n- Who it affects\n- When it starts\n- What, if anything, to do now\n\n## What we would do\n\nA short, practical next step. Link to [HMRC guidance](https://www.gov.uk/government/organisations/hm-revenue-customs) where it helps.',
  'Tax',
  false
);

-- Key dates.
insert into public.key_dates (user_id, label, date, description, audience)
values
  ('17713ad0-ae7a-4880-b53e-abdf83894922', 'Self Assessment deadline', '2027-01-31',
   'Last day to file your 2025/26 tax return online and pay the tax you owe, including any first payment on account for 2026/27.',
   'Sole traders, Landlords'),
  ('17713ad0-ae7a-4880-b53e-abdf83894922', 'Tax year ends', '2027-04-05',
   'The 2026/27 tax year ends. Allowances and pension or ISA contributions you want to count for this year need to be used by today.',
   'Everyone'),
  ('17713ad0-ae7a-4880-b53e-abdf83894922', 'Second payment on account', '2027-07-31',
   'Second payment on account towards your 2026/27 tax bill, if HMRC has asked you to make payments on account.',
   'Sole traders, Landlords');
