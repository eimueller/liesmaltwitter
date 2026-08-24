import requests
import csv
import io
import os
from datetime import date

CF_ACCOUNT_ID = os.environ["CF_ACCOUNT_ID"]
CF_DATABASE_ID = os.environ["CF_DATABASE_ID"]
CF_API_TOKEN = os.environ["CF_API_TOKEN"]

D1_URL = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_DATABASE_ID}/query"
HEADERS = {"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"}


def run_sql(sql, params=None):
    r = requests.post(D1_URL, headers=HEADERS, json={"sql": sql, "params": params or []})
    r.raise_for_status()
    return r.json()


def get_all_chunk_urls():
    today = date.today()
    base = f"https://ton.twimg.com/birdwatch-public-data/{today.year}/{today.month:02d}/{today.day:02d}/notes"
    urls = []
    i = 0
    while True:
        url = f"{base}/notes-{i:05d}.tsv"
        r = requests.get(url, stream=True, headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code != 200:
            r.close()
            print(f"{url} -> Status {r.status_code}, stoppe hier")
            break
        r.close()
        urls.append(url)
        i += 1
    return urls


def stream_and_insert(url):
    with requests.get(url, stream=True) as resp:
        resp.raise_for_status()
        lines = (line.decode("utf-8") for line in resp.iter_lines())
        reader = csv.DictReader(lines, delimiter="\t")

        batch = []
        total = 0
        for row in reader:
            batch.append((
                row.get("noteId"), row.get("tweetId"), row.get("createdAtMillis"),
                row.get("classification"), row.get("summary"),
                1 if row.get("trustworthySources") == "1" else 0,
                1 if row.get("isMediaNote") == "1" else 0,
            ))
            if len(batch) >= 500:
                insert_batch(batch)
                total += len(batch)
                batch = []
        if batch:
            insert_batch(batch)
            total += len(batch)
        return total


def insert_batch(rows):
    values_sql = ",".join(["(?,?,?,?,?,?,?)"] * len(rows))
    flat_params = [v for row in rows for v in row]
    run_sql(
        "INSERT OR IGNORE INTO notes "
        "(noteId, tweetId, createdAtMillis, classification, summary, trustworthySources, isMediaNote) "
        f"VALUES {values_sql}",
        flat_params,
    )


if __name__ == "__main__":
    urls = get_all_chunk_urls()
    print(f"{len(urls)} Chunk-Dateien gefunden")
    grand_total = 0
    for url in urls:
        n = stream_and_insert(url)
        print(f"{url}: {n} Zeilen verarbeitet")
        grand_total += n
    print(f"Fertig, insgesamt {grand_total} Zeilen")