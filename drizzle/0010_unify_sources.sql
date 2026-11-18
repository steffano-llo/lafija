-- S20: unify each user's application sources. A form is the source trimmed with every whitespace
-- run collapsed to one space; forms equal ignoring case are one group per user. Each group gets the
-- user's most frequent form; among equally frequent forms the preset spelling wins when present,
-- else the first in byte order (collate "C"). Blank sources become null. Other columns, updated_at
-- included, are untouched, and one user's rows never decide another user's form.
WITH "normalized" AS (
  SELECT a."id", a."user_id", nullif(btrim(regexp_replace(a."source", '\s+', ' ', 'g')), '') AS "form"
  FROM "application" a
  WHERE a."source" IS NOT NULL
),
"counted" AS (
  SELECT n."user_id", n."form", count(*) AS "n"
  FROM "normalized" n
  WHERE n."form" IS NOT NULL
  GROUP BY n."user_id", n."form"
),
"canonical" AS (
  SELECT DISTINCT ON (c."user_id", lower(c."form")) c."user_id", lower(c."form") AS "key", c."form"
  FROM "counted" c
  ORDER BY c."user_id", lower(c."form"), c."n" DESC,
    (c."form" IN ('LinkedIn', 'Computrabajo', 'Bumeran', 'Get on Board', 'Indeed', 'Referido')) DESC,
    c."form" COLLATE "C"
)
UPDATE "application" a
SET "source" = k."form"
FROM "normalized" n
LEFT JOIN "canonical" k ON k."user_id" = n."user_id" AND k."key" = lower(n."form")
WHERE a."id" = n."id" AND a."source" IS DISTINCT FROM k."form";
