CREATE TABLE IF NOT EXISTS notes (
    noteId TEXT PRIMARY KEY,
    tweetId TEXT,
    createdAtMillis INTEGER,
    classification TEXT,
    summary TEXT,
    trustworthySources INTEGER,
    isMediaNote INTEGER
);