import { useRef, useState } from 'preact/hooks';

type CSSProps = Record<string, string | number>;

const S = {
  box: (active: boolean): CSSProps => ({
    border: `1px dashed ${active ? '#58a6ff' : '#484f58'}`,
    borderRadius: 10,
    background: active ? '#17263d' : '#0d1117',
    padding: '22px 16px',
    textAlign: 'center',
    transition: 'border-color 120ms ease, background 120ms ease',
  }),
  title: { color: '#f0f6fc', fontWeight: 650, fontSize: 15 } as CSSProps,
  hint: { color: '#8b949e', fontSize: 13, marginTop: 5 } as CSSProps,
  button: {
    marginTop: 12,
    background: '#21262d',
    color: '#f0f6fc',
    border: '1px solid #30363d',
    borderRadius: 7,
    padding: '8px 14px',
    cursor: 'pointer',
  } as CSSProps,
} as const;

interface FileDropzoneProps {
  file: File | null;
  onFile: (file: File) => void;
  accept?: string;
  disabled?: boolean;
  title?: string;
  hint?: string;
}

export function FileDropzone({
  file,
  onFile,
  accept,
  disabled = false,
  title = '拖放文件到这里',
  hint = '或点击选择文件',
}: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const choose = () => {
    if (!disabled) inputRef.current?.click();
  };

  const acceptFile = (candidate: File | undefined) => {
    if (!disabled && candidate) onFile(candidate);
  };

  return (
    <div
      style={S.box(dragging)}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={(event) => {
        event.preventDefault();
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        acceptFile(event.dataTransfer?.files?.[0]);
      }}
      aria-disabled={disabled}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        disabled={disabled}
        onChange={(event) => acceptFile((event.target as HTMLInputElement).files?.[0])}
      />
      <div style={S.title}>{file ? file.name : title}</div>
      <div style={S.hint}>{file ? formatBytes(file.size) : hint}</div>
      <button type="button" style={S.button} disabled={disabled} onClick={choose}>
        {file ? '更换文件' : '选择文件'}
      </button>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
