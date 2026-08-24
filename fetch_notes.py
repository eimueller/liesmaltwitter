import requests
import csv
import os
import zipfile
import tempfile
from datetime import date, timedelta

CF_ACCOUNT_ID = os.environ["CF_ACCOUNT_ID"]
CF_DATABASE_ID = os.environ["CF_DATABASE_ID"]
CF_API_TOKEN = os.environ["CF_API_TOKEN"]

D1_URL = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_DATABASE_ID}/query"
HEADERS = {"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"}
UA = {"User-Agent": "Mozilla/5.0"}

ROWS_PER_STATEMENT = 14        # 14 Zeilen x 7 Spalten = 98 Parameter, unter dem D1-Limit von 100
STATEMENTS_PER_REQUEST = 50    # so viele Einzel-Befehle werden per "batch" zu einer Anfrage gebündelt


def get_chunk_urls_for(day):
    base = f"https://ton.twimg.com/birdwatch-public-data/{day.year}/{day.month:02d}/{day.day:02d}/notes"
    chunks = []
    i = 0
    while True:
        found = None
        for ext, is_zip in [(".zip", True), (".tsv", False)]:
            url = f"{base}/notes-{i:05d}{ext}"
            r = requests.get(url, stream=True, headers=UA)
            status = r.status_code
            r.close()
            if status == 200:
                found = (url, is_zip)
                break
        if not found:
            print(f"notes-{i:05d} -> nichts gefunden (weder .zip noch .tsv), stoppe hier")
            break
        chunks.append(found)
        i += 1
    return chunks


def get_all_chunk_urls():
    today = date.today()
    chunks = get_chunk_urls_for(today)
    if chunks:
        print(f"Nutze heutigen Snapshot: {today}")
        return chunks
    yesterday = today - timedelta(days=1)
    print(f"Heute ({today}) nichts gefunden, versuche gestern ({yesterday})")
    return get_chunk_urls_for(yesterday)


def make_insert_statement(rows):
    values_sql = ",".join(["(?,?,?,?,?,?,?)"] * len(rows))
    params = [str(v) for row in rows for v in row]
    sql = ("INSERT OR IGNORE INTO notes "
           "(noteId, tweetId, createdAtMillis, classification, summary, trustworthySources, isMediaNote) "
           f"VALUES {values_sql}")
    return {"sql": sql, "params": params}


def flush_statements(statement_list):
    if not statement_list:
        return
    r = requests.post(D1_URL, headers=HEADERS, json={"batch": statement_list})
    if not r.ok:
        print("D1-Fehlerantwort:", r.text[:1000])
    r.raise_for_status()


def process_rows(reader):
    row_buffer = []
    statement_buffer = []
    total = 0

    for row in reader:
        row_buffer.append((
            row.get("noteId"), row.get("tweetId"), row.get("createdAtMillis"),
            row.get("classification"), row.get("summary"),
            1 if row.get("trustworthySources") == "1" else 0,
            1 if row.get("isMediaNote") == "1" else 0,
        ))
        total += 1

        if len(row_buffer) >= ROWS_PER_STATEMENT:
            statement_buffer.append(make_insert_statement(row_buffer))
            row_buffer = []

        if len(statement_buffer) >= STATEMENTS_PER_REQUEST:
            flush_statements(statement_buffer)
            statement_buffer = []
            print(f"  ...{total} Zeilen verarbeitet", flush=True)

    if row_buffer:
        statement_buffer.append(make_insert_statement(row_buffer))
    flush_statements(statement_buffer)

    return total


def stream_and_insert_tsv(url):
    with requests.get(url, stream=True, headers=UA) as resp:
        resp.raise_for_status()
        lines = (line.decode("utf-8") for line in resp.iter_lines())
        return process_rows(csv.DictReader(lines, delimiter="\t"))


def stream_and_insert_zip(url):
    with tempfile.NamedTemporaryFile() as tmp:
        with requests.get(url, stream=True, headers=UA) as resp:
            resp.raise_for_status()
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                tmp.write(chunk)
        tmp.flush()
        with zipfile.ZipFile(tmp.name) as zf:
            inner_name = zf.namelist()[0]
            with zf.open(inner_name) as f:
                lines = (line.decode("utf-8") for line in f)
                return process_rows(csv.DictReader(lines, delimiter="\t"))


if __name__ == "__main__":
    chunks = get_all_chunk_urls()
    print(f"{len(chunks)} Chunk-Dateien gefunden")
    grand_total = 0
    for url, is_zip in chunks:
        print(f"Verarbeite: {url}")
        n = stream_and_insert_zip(url) if is_zip else stream_and_insert_tsv(url)
        print(f"{url}: {n} Zeilen verarbeitet")
        grand_total += n
    print(f"Fertig, insgesamt {grand_total} Zeilen")