import { useRef, useState } from 'react';

/**
 * 内容卡 banner 内的复制按钮：文案互换 复制→已复制（1000ms，DSH §12）。
 * stopPropagation 防止触发展开行的折叠。
 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1000);
    });
  };

  return (
    <button onClick={handleCopy} className="ap-copybtn shrink-0">
      {copied ? '已复制' : '复制'}
    </button>
  );
}
