#!/bin/sh
# Собирает функцию school в один файл index.ts, чтобы её можно было вставить в веб-редактор Supabase.
cd "$(dirname "$0")/functions/school" || exit 1
{
  echo '// @ts-nocheck'
  echo '// Файл собран из untis.js и main.ts скриптом supabase/build-school.sh. Править исходники, не этот файл.'
  echo
  sed -n '/^import /p' main.ts
  echo
  cat untis.js
  echo
  sed '/^import /d' main.ts
} > index.ts
echo "ok: $(wc -l < index.ts) строк"
