# Servers and files

The **Servers** view of DataNest is a file manager for machines you reach over SSH. It is
separate from database connections: a server is only a way to log in, and what you do on it
is browse, open, edit, upload, download, copy, rename and delete files.

## Adding a server

**Add Server…** (the plus in the view title) opens a form in the editor, like the form of a
new connection. Fill in the **name**, an optional **start folder** and colour, and whether the
server is **read-only**; then the **SSH host**, **port**, **user** and how to sign in
(password, private key with its passphrase, or the SSH agent). **SSH algorithms** folds away
under the sign-in for old servers that need a weak method.

- Passwords and key passphrases go to the editor's secret storage and nowhere else.
- **Test connection** logs in with what is on the form, opens SFTP and tells you the login
  folder (and how many jump hosts the way led through); nothing is saved by the test.
- The first time DataNest meets a server it asks you to trust its key, and a key that changes
  later is refused unless you accept the new one — the same as for database tunnels.
- **Route to the server**: add **jump hosts** (up to five, each with its own login, in the
  order they are logged in to) and, if you need one, a **SOCKS5 or HTTP proxy**. Passwords of
  jump hosts and of the proxy go to the editor's secret storage too.
- **Edit Server…** opens the same form with the saved values. A saved password is not shown:
  leave its box empty to keep it, type a new one to replace it, or tick *Remove the saved
  password*.
- **Export Servers…** writes the list **without any secret**; **Import Servers…** reads it
  back, and you enter the passwords when you connect.

## Browsing

Open a server to list its start folder (or the login folder). Folders open as you expand them,
and nothing is read ahead. Each line shows the size, the permissions (`rw-r--r--`) and the
date; folders and files wear an icon and a colour by kind. A link shows what it leads to; a
broken one is marked. `datanest.servers.showHidden` turns the listing of dot-files off.

A session is shared by everything you do with a server, closes after five quiet minutes and
opens again by itself when needed. **Disconnect** closes it at once.

## Opening and editing

Click a file to open it in the editor. Saving writes it back over SFTP. The editor compares
the time and size it saw with what the server says when you save, so a file somebody else
changed meanwhile shows the usual conflict instead of being overwritten.

A file larger than `datanest.servers.maxOpenSizeMb` (5 MB) is offered for download instead,
and a file whose name says it is not text (an archive, a database, a binary) asks before it
opens.

## Transfers

- **Upload Files…** and **Upload Folders…** on a server or a folder; you can also **drop
  files from the explorer** onto a folder.
- **Download…** takes files or whole folders to a folder of this machine.
- **Copy To…** copies to another path of the same server or to another server; **Move To…**
  renames within the server, or, for another server, copies first and deletes the original
  only after every file arrived (and keeps it, saying so, if links or special files were not
  copied).
- **Drag and drop inside the tree** moves files and folders into the folder you drop them on
  (a drop on a file means its folder, a drop on a server means its start folder). Between two
  servers it asks first.
- **Compare with a Local File…** opens the usual side-by-side diff of a file of this machine
  against the file on the server (text files within the editor size limit).
- **Compare with a File of a Server…** does the same for two files on servers: pick the other
  server (it may be the same one) and the path; the diff shows each file under its server's name.
- Transfers are streams: memory stays small for any size. A notification shows the progress
  and **Cancel** stops the transfer; a half-written file is removed.
- Something that is already there is replaced only after you confirm.
- Links to folders and special files are not followed or copied, so a link back into the
  tree cannot make a copy run forever.

## Terminal and commands

- **Open Terminal** (the button on a server, or the menu of a server or a folder) opens a
  real shell in the editor's terminal panel, with a pseudo-terminal: colours, full-screen
  programs, `Ctrl+C`, resizing and UTF-8 work as in any terminal. On a folder it starts in
  that folder. The icon takes the server's colour.
- It uses the same login as the file browser: jump hosts, proxy, SSH algorithms and the host
  key check. Nothing from your own environment is passed to the server.
- When the shell ends (`exit`) or the link drops, the terminal says so and any key logs in
  again; closing the terminal ends the connection. At most eight terminals can be open on one
  server.
- **Run Command on Server…** runs one command without a terminal and writes its output to an
  output channel named after the server; Cancel in the notification stops it. It runs in the
  folder you started from.
- A **read-only** server is not opened for a terminal or a command until you confirm: read-only
  is DataNest's promise about its own file operations, and a shell can break it.

## Safety

- A server marked **read-only** offers no change at all: upload, new, rename, delete and
  permission commands are not shown, and are refused if called some other way.
- Deleting asks first and says that a folder goes with everything in it; a link is removed
  without touching what it points at.
- **Change Permissions…** takes octal digits (`644`, `0755`).
- **Change Permissions Inside…** (folders) gives every file and every folder below its own
  mode, e.g. `644` and `755`; leave a box empty to keep that kind as it is. It asks first.
- **Change Owner…** takes `user:group` by **name or by number** (`deploy:www`, `1000:1000`,
  `deploy`, `:www`); for a folder you choose whether everything inside changes too. The names
  are the server's own: they are read once per connection from `/etc/passwd` and `/etc/group`
  as ordinary files (nothing is run there), shown in the tooltip of a file, and a name the
  server does not have is refused with a word. Where those files cannot be read, numbers still
  work. The server decides who may change an owner — usually only root. Links are never
  followed by these commands.
