# Servers and files

The **Servers** view of DataNest is a file manager for machines you reach over SSH. It is
separate from database connections: a server is only a way to log in, and what you do on it
is browse, open, edit, upload, download, copy, rename and delete files.

## Adding a server

**Add Server…** (the plus in the view title) asks one thing at a time: a name, the host, the
port, the user, how to log in (password, key file or SSH agent), a start folder and whether
the server is read-only.

- Passwords and key passphrases go to the editor's secret storage and nowhere else.
- The first time DataNest meets a server it asks you to trust its key, and a key that changes
  later is refused unless you accept the new one — the same as for database tunnels.
- **Edit Server…** keeps what you leave empty: an empty password keeps the saved one. Jump
  hosts, a proxy and algorithm rules saved with a server are kept as they are.
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
  renames within the server.
- Transfers are streams: memory stays small for any size. A notification shows the progress
  and **Cancel** stops the transfer; a half-written file is removed.
- Something that is already there is replaced only after you confirm.
- Links to folders and special files are not followed or copied, so a link back into the
  tree cannot make a copy run forever.

## Safety

- A server marked **read-only** offers no change at all: upload, new, rename, delete and
  permission commands are not shown, and are refused if called some other way.
- Deleting asks first and says that a folder goes with everything in it; a link is removed
  without touching what it points at.
- **Change Permissions…** takes octal digits (`644`, `0755`).

## Not here yet

An SSH terminal and moving by drag and drop inside the tree are not part of this view.
