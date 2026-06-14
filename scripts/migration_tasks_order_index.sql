alter table public.tasks
  add column if not exists order_index integer not null default 0;

with ranked as (
  select
    id,
    row_number() over (
      partition by topic_id
      order by created_at nulls last, id
    ) - 1 as next_order_index
  from public.tasks
)
update public.tasks as t
set order_index = ranked.next_order_index
from ranked
where t.id = ranked.id;

create index if not exists idx_tasks_topic_order
  on public.tasks (topic_id, order_index, created_at, id);
