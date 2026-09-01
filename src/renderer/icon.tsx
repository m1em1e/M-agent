export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    play: "M7 5v14l11-7z",
    pause: "M7 5h4v14H7zm7 0h4v14h-4z",
    stop: "M6 6h12v12H6z",
    undo: "M9 7 4 12l5 5v-3h5a5 5 0 0 0 5-5 7 7 0 0 0-.3-2A7 7 0 0 1 14 11H9z",
    redo: "m15 7 5 5-5 5v-3h-5a5 5 0 0 1-5-5 7 7 0 0 1 .3-2A7 7 0 0 0 10 11h5z",
    pointer: "m7 3 10 9-5 1 3 6-2 1-3-6-3 4z",
    pencil: "m5 16-1 4 4-1L19 8l-3-3zM14 7l3 3",
    plus: "M12 5v14M5 12h14",
    settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m8 4 2-1-2-4-2 1-2-1-1-3H9l-1 3-2 1-2-1-2 4 2 1v2l-2 1 2 4 2-1 2 1 1 3h6l1-3 2-1 2 1 2-4-2-1v-2z",
    download: "M12 3v12m-5-5 5 5 5-5M5 20h14",
    folder: "M3 6h7l2 2h9v11H3z",
    spark: "m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z",
    send: "m4 4 17 8-17 8 3-7 8-1-8-1z",
    close: "m6 6 12 12m0-12L6 18",
    trash: "M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13",
    lock: "M7 11h10v9H7zm2 0V8a3 3 0 0 1 6 0v3",
    check: "m5 12 4 4L19 6",
    warning: "M12 3 2.5 20h19zM12 9v5m0 3h.01",
    cloud: "M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9z",
    chart: "M5 19V9m7 10V5m7 14v-7",
    music: "M9 18V6l10-2v12M9 9l10-2M6 20a3 2 0 1 0 0-4 3 2 0 0 0 0 4m10-2a3 2 0 1 0 0-4 3 2 0 0 0 0 4",
    plugin: "M9 3v4H5v4H2v4h3v4h4v3h4v-3h4v-4h3v-4h-3V7h-4V3z",
    panel: "M4 5h16v14H4zM15 5v14m2-10h1m-1 3h1m-1 3h1",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] ?? paths.spark} />
    </svg>
  );
}