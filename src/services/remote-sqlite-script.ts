// The helper that changes a SQLite file on a server (V13.33). It is a short Python 3 program
// started over SSH: Python ships SQLite (the `sqlite3` module), so nothing has to be installed.
// The program text travels inside the command line as base64 (letters, digits, `+`, `/` and
// `=` only, safe in any POSIX shell); nothing the user typed does: the file path and every
// statement come afterwards on standard input, one JSON object per line, and the answers come
// back the same way. Both directions are plain ASCII (non-ASCII text is escaped as \uXXXX), so
// the server's locale cannot garble them.

/** The program. One request per line in, one answer per line out; see `RemoteSqliteWriter`. */
export const HELPER_SOURCE = String.raw`
import sys, json, sqlite3, base64
from urllib.parse import quote

MAX_ROWS = 5000

def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()

def val(v):
    if isinstance(v, (bytes, bytearray, memoryview)):
        return {"b": base64.b64encode(bytes(v)).decode("ascii")}
    if isinstance(v, int) and not isinstance(v, bool) and abs(v) > 9007199254740991:
        return {"i": str(v)}
    if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
        return None
    return v

def fail(rid, e, conn):
    name = getattr(e, "sqlite_errorname", None)
    code = getattr(e, "sqlite_errorcode", None)
    out({
        "id": rid, "ok": False, "message": str(e), "kind": e.__class__.__name__,
        "name": name, "code": code,
        "tx": bool(conn.in_transaction) if conn is not None else False,
    })

conn = None
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    rid = None
    try:
        req = json.loads(line)
        rid = req.get("id")
        op = req.get("op")
        if op == "open":
            uri = "file:" + quote(req["path"]) + "?mode=rw"
            conn = sqlite3.connect(uri, uri=True, timeout=req.get("busy", 5000) / 1000.0, isolation_level=None)
            for sql in req.get("init", []):
                conn.execute(sql)
            out({"id": rid, "ok": True, "version": sqlite3.sqlite_version, "python": sys.version.split()[0]})
        elif op == "exec":
            cur = conn.execute(req["sql"])
            cols = [d[0] for d in cur.description] if cur.description else None
            rows = None
            if cols is not None:
                rows = [[val(v) for v in r] for r in cur.fetchmany(MAX_ROWS)]
                cur.fetchall()
            n = cur.rowcount
            out({
                "id": rid, "ok": True, "cols": cols, "rows": rows,
                "changes": n if n is not None and n >= 0 else None,
                "tx": bool(conn.in_transaction),
            })
        elif op == "close":
            if conn is not None:
                conn.close()
            out({"id": rid, "ok": True})
            break
        else:
            out({"id": rid, "ok": False, "message": "unknown request", "kind": "Request"})
    except sqlite3.Error as e:
        fail(rid, e, conn)
    except Exception as e:
        out({"id": rid, "ok": False, "message": str(e), "kind": e.__class__.__name__,
             "tx": bool(conn.in_transaction) if conn is not None else False})
`;

/** The Python that loads the program from its base64 text: the argument of `python3 -c`. */
export function helperProgram(): string {
  const encoded = Buffer.from(HELPER_SOURCE, 'utf8').toString('base64');
  return `import base64;exec(base64.b64decode("${encoded}"))`;
}

/** The command that starts the helper: `python3` runs the program, which waits for requests. */
export function helperCommand(): string {
  return `python3 -u -c '${helperProgram()}'`;
}
