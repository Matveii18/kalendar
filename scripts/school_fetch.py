"""Скачивает расписание класса с сайта колледжа и отправляет его в Supabase (функция school).

Запускается из GitHub Actions (.github/workflows/school.yml): сайт колледжа не пускает серверы Supabase.
Логин и пароль берутся из секретов GitHub. Логи репозитория открыты всем, поэтому
скрипт печатает только служебные сообщения и количество уроков, без содержимого страниц.
"""

import http.cookiejar
import json
import os
import re
import sys
import urllib.parse
import urllib.request

BASE = "https://osp2.stadt-koeln.de"
FUNC = "https://iqxlgaefulwklbsmecym.supabase.co/functions/v1/school"

school = (os.environ.get("COLLEGE_SCHOOL") or "175031").strip()
user = (os.environ.get("COLLEGE_USER") or "").strip()
password = os.environ.get("COLLEGE_PASSWORD") or ""
class_name = (os.environ.get("COLLEGE_CLASS") or "2659").strip()
token = (os.environ.get("SCHOOL_PUSH_TOKEN") or "").strip()
if not (user and password and token):
    print("Секреты COLLEGE_USER, COLLEGE_PASSWORD и SCHOOL_PUSH_TOKEN ещё не добавлены в GitHub")
    sys.exit(0)
force = os.environ.get("FORCE") == "1"


def call_func(method, data=None):
    req = urllib.request.Request(
        FUNC + ("?due" if method == "GET" else ""),
        data=json.dumps(data).encode() if data is not None else None,
        method=method,
        headers={"x-school-token": token, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


if not force and not call_func("GET").get("due"):
    print("По графику проверять пока рано")
    sys.exit(0)

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.addheaders = [("User-Agent", "Mozilla/5.0 (Kalendar schedule check)")]


def get(path):
    with opener.open(BASE + path, timeout=30) as r:
        if "login.php" in r.geturl():
            raise SystemExit(f"Сайт колледжа не пустил на {path}: проверь логин и пароль в секретах GitHub")
        return r.read().decode("cp1252")


opener.open(BASE + "/login.php", timeout=30).read()
form = urllib.parse.urlencode({"schulnummer": school, "benutzername": user, "passwort": password}).encode()
opener.open(BASE + "/process.php", data=form, timeout=30).read()
get("/schueler.php")  # кнопка Schülerplan

folder = f"/untis/{school}/schueler"
nav = get(f"{folder}/frames/navbar.htm")

classes = re.search(r"var\s+classes\s*=\s*\[([^\]]*)\]", nav)
names = [s.strip().strip('"') for s in classes.group(1).split(",")] if classes else []
if class_name not in names:
    raise SystemExit(f"Класс {class_name} не найден на сайте")
page = f"c{names.index(class_name) + 1:05d}.htm"

week_select = re.search(r'<select[^>]*name\s*=\s*"?week"?[^>]*>(.*?)</select>', nav, re.S | re.I)
weeks = re.findall(r'<option[^>]*value\s*=\s*"?(\d+)"?', week_select.group(1), re.I) if week_select else []
if not weeks:
    raise SystemExit("На сайте не нашлось ни одной недели")

pages = [{"week": w, "html": get(f"{folder}/{w}/c/{page}")} for w in weeks]
result = call_func("POST", {"nav": nav, "pages": pages})
if not result.get("ok"):
    raise SystemExit(f"Supabase не принял расписание: {result.get('error')}")

for w in result.get("weeks", []):
    print(f"Неделя с {w['monday']}: уроков {w['lessons']}{', есть изменения' if w['changed'] else ''}")
