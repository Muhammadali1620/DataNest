# Tools

## ER diagram

**Show ER Diagram** on a connection, database, schema, the **Tables** folder or chosen
tables draws a box per table with its columns, primary and foreign key marks, and the
keys between tables in crow's foot notation. Tables are laid out automatically — a
referenced table left of the tables that point at it — and can be dragged. Pan, zoom,
find a table, highlight its keys with a click, open its rows with a double click. Show all
columns, key columns only or just the names. **Save SVG** and **Save PNG** keep the colours
of the current theme. From the keyboard: arrows pan, `]` and `[` go from table to table.

## Query plans

**Explain Plan** (editor context menu or Command Palette) shows the plan of the statement
under the cursor beside the editor, as a tree: operation, table and index, condition, cost
and rows. The nodes that take the most time or cost are marked, and warnings point at full
scans, sorts, temporary tables, spills to disk, joins without a condition and estimates
that are far off. **Explain Analyze** runs the statement for the real rows and times —
only statements that read. Works on PostgreSQL, MySQL, MariaDB, SQLite, SQL Server (with
its missing index advice), ClickHouse, Oracle, TiDB, CockroachDB and YugabyteDB.

## Comparing schemas

**Compare Schemas…** on a connection, database or schema compares it (the source) with
another schema of the same kind of database (the target): tables — columns, keys, indexes,
comments — and the definitions of views, routines, triggers and sequences, line by line.
Tick the differences to apply and open the migration script: it creates, alters and drops
in an order that works. The script only opens in an editor bound to the target; it runs
when you run it.

## Comparing data

**Compare Data…** on a table compares its rows with a table of any connection — another
database, even another kind of database — matched by key. You see how many rows are the
same, which differ (changed cells marked) and which are only on one side. Values written
differently by different servers (`10.50` and `10.5`, `true` and `1`, JSON with keys in
another order) count as equal. The sync script inserts, updates and, if you ask, deletes
rows so the target matches.

## Server monitor

**Server Monitor** on a SQL connection shows the server's sessions — who, from where, what
they run, how long and what they wait for (and who blocks them) — refreshed every few
seconds. Cancel a statement or end a session after a question; the monitor's own session is
left alone, and a read-only connection stops nothing. Other tabs list the variables of the
session and the server and the status counters with their change per second.

## Users and privileges

**Users and Privileges** on a connection or database lists accounts and roles with their
flags (locked, expired password, superuser, …), the roles they belong to and their
privileges by level and object. Create, change and drop accounts and roles, set passwords,
lock and unlock, grant and revoke — every change is shown as SQL before it runs, and a
statement with a password is never written to an editor.

## Finding data

**Find Data…** on a connection, database, schema or **Tables** folder looks for a text in
every text column of every table, without regard to case — `%`, `_` and the like are taken
as themselves. Each table is asked once, so you see how many rows hold the text and in
which columns. Pick a table to open it filtered to exactly those rows. Numbers, dates,
binary and JSON columns are not searched; tables the server does not let you read are
listed in the log. **Cancel** stops after the table being read.

## Documenting a database

**Document Database…** on a connection, database or schema writes a Markdown document:
every table with its columns (type, `NULL`, default, keys, comment), indexes, foreign keys
— linked to the tables they point at — and the tables that point at it, then the
definitions of views, routines, triggers and sequences. It opens as a new file to read,
change and save.

## Command-line clients

**Open in Terminal** on a connection opens the database's own client in a terminal of
the editor: `mysql` (or `mariadb`), `psql`, `sqlite3`, `sqlcmd`, `clickhouse client`,
SQLcl or SQL\*Plus, `redis-cli`, `mongosh` — the first one installed on the `PATH`. It
connects where DataNest does, through the SSH tunnel or proxy when there is one, which
stays open as long as the terminal. The password goes to the client in its environment
variable (`MYSQL_PWD`, `PGPASSWORD`, …), never on the command line; Oracle's clients and
`mongosh` ask for it themselves. `clickhouse client` speaks the native protocol, on the
server's default port.

## The Tools page

**Tools** (Command Palette, or the toolbar of a result) is a page of small utilities. It
keeps the tab and what you typed while its editor tab is hidden. Nothing leaves your
machine unless you start a check that says where it goes.

**Network.** Host name and local addresses show at once. **Get info** asks `api.ipify.org`
(and `api6.ipify.org` for IPv6) for the address the internet sees; nothing is sent before
you press it. **Port check** opens a TCP connection and closes it. **DNS lookup** uses the
system resolver, or — if you choose *DNS over HTTPS* — asks Cloudflare (`cloudflare-dns.com`)
or Google (`dns.google`) for A, AAAA, MX, TXT, CNAME or NS records. **Ping** runs your
system's own `ping` (ICMP) and shows its lines as they come, with a stop button; the name
can be resolved over HTTPS first. A machine without `ping` is told to use the **TCP ping**,
which measures how long a TCP connect takes.

**Colors.** Pick a colour as HEX or RGB and see the derived shades (hover, active, light,
text on the colour, soft background and border) and twenty samples drawn from them — button,
outline, disabled, link, tag, focus border, tinted background, icon, tab, list item, badge,
switch, input, checkbox and radio, progress, notice, tooltip, card, table row and code.

**Task manager.** The processes of the machine with CPU, memory, user, PID, run time and
command (`ps` on Linux and macOS, PowerShell and `tasklist` on Windows). Search by name,
PID, user or command, show only your own processes, sort by any column, refresh by hand
or every 5, 10 or 30 seconds. **End** asks the program to stop and **Force quit** kills it,
each after a question; the editor's own process is never offered. On Linux and macOS the
CPU figure is the average over the process's life, as `ps` reports it; on Windows it is the
processor time used so far.

**Settings.** The extension's own `datanest.*` settings in groups (General, Editor,
Formatting, SQL, Tree, Result, Redis), each with the real setting id under it; a dot marks
a value that differs from the default, and every group has a reset button. Changes go to
your user settings and follow changes made in the Settings editor. The page also has
buttons to export and import the connection list, close all connections, clear the schema
cache and report an issue. DataNest has no servers, so there is no cloud sync.

**QR code.** *Read:* choose, drop or paste a picture; the code is found and decoded on your
machine (no library, no network), also when the picture is turned or seen at an angle. A
link gets an **Open link** button, and the editor asks before it opens anything. Recent
results are kept in a list. *Create:* write a text or a link, pick the error-correction
level (L, M, Q or H), the quiet zone, the size and the colours; the page warns when the
colours are too close or the code is light on dark. Save it as PNG or SVG, or copy it.

**Image.** A list of tools on the left. **Crop** has a box you drag by its edges and corners
(or move with the arrow keys; Shift is ten pixels, Alt with an arrow resizes), with free,
1:1, 4:3, 16:9, 3:2 or your own ratio, numbers for position and size, and PNG, JPEG or WebP
output. **Resize** scales to a size with or without the proportions. **Compress** works on
your machine (a PNG gets 8–256 colours and is written as an indexed PNG, a JPEG or WebP a
lower quality) or with **TinyPNG**: save your own key once (it lives in the editor's secret
storage, not in a file) and the picture is sent to TinyPNG only when you press Compress.
**To Base64** gives a data URL, a CSS `url()` and an HTML `<img>`. The **SVG editor** formats
and recolours SVG text. The **SVG designer** draws rectangles, circles, ellipses, lines,
polylines and polygons (the pen) and text; select, move, resize and turn them with the mouse
or the keys, change fill, outline, opacity and corners, order the layers, snap to a grid,
undo and redo, then save SVG or PNG, copy the SVG, or send it to the SVG editor. It also
opens SVG files made of simple shapes and says how many elements it had to leave out.

## Charts

See [Results and editing](results.md#charts).
