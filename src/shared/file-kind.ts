// What kind of file a name looks like, for the icon and the colour in the file browser
// (V13.16) and for the question "does this open as text?". It goes by the name alone: the
// browser lists thousands of files and reads none of them.

export type FileKind =
  | 'folder'
  | 'code'
  | 'script'
  | 'config'
  | 'text'
  | 'markup'
  | 'data'
  | 'image'
  | 'media'
  | 'archive'
  | 'database'
  | 'document'
  | 'key'
  | 'binary'
  | 'other';

const EXTENSIONS: readonly (readonly [FileKind, string])[] = [
  [
    'code',
    'js mjs cjs ts tsx jsx py rb go rs java kt kts cs cpp cc c h hpp php swift scala lua pl r dart vue svelte css scss less sass',
  ],
  ['script', 'sh bash zsh fish bat cmd ps1 psm1'],
  ['config', 'ini conf cfg toml yaml yml env properties service timer socket lock'],
  ['text', 'txt log md markdown rst csv tsv'],
  ['markup', 'html htm xml xhtml svg xsl'],
  ['data', 'json jsonl ndjson sql'],
  ['image', 'png jpg jpeg gif webp bmp ico tiff avif heic'],
  ['media', 'mp3 wav flac ogg m4a mp4 mkv avi mov webm'],
  ['archive', 'zip tar gz tgz bz2 xz zst 7z rar jar war deb rpm'],
  ['database', 'db sqlite sqlite3 mdb sdb'],
  ['document', 'pdf doc docx odt xls xlsx ods ppt pptx odp'],
  ['key', 'pem key crt cer pub p12 pfx asc gpg'],
  ['binary', 'exe dll so dylib bin o a class pyc iso img dmp core'],
];

const BY_EXTENSION: ReadonlyMap<string, FileKind> = new Map(
  EXTENSIONS.flatMap(([kind, list]) =>
    list.split(' ').map((extension): [string, FileKind] => [extension, kind]),
  ),
);

const BY_NAME: Readonly<Record<string, FileKind>> = {
  dockerfile: 'config',
  makefile: 'script',
  '.bashrc': 'config',
  '.profile': 'config',
  '.gitignore': 'config',
  '.env': 'config',
  authorized_keys: 'key',
  known_hosts: 'config',
  id_rsa: 'key',
  id_ed25519: 'key',
  readme: 'text',
  license: 'text',
};

/** The kind of a file, by its name; `other` when the name says nothing. */
export function fileKindOf(name: string): FileKind {
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName !== undefined) {
    return byName;
  }
  const dot = lower.lastIndexOf('.');
  if (dot <= 0 && !lower.startsWith('.')) {
    return 'other';
  }
  // `.env.local`-style names: the part after the first dot of a hidden file counts too.
  const extension = lower.slice(dot + 1);
  const found = BY_EXTENSION.get(extension);
  if (found !== undefined) {
    return found;
  }
  return lower.startsWith('.env') ? 'config' : 'other';
}

/** True for the kinds that are not worth opening in a text editor. */
export function opensAsText(kind: FileKind): boolean {
  return kind !== 'archive' && kind !== 'database' && kind !== 'binary' && kind !== 'media';
}
