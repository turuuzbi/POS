/** Hides the admin shell (sidebar, header) when a document page is printed. */
export function PrintStyles() {
  return (
    <style>{`@media print {
  aside, header { display: none !important; }
  main { max-width: none !important; padding: 0 !important; }
  body { background: #fff !important; color: #000 !important; }
}`}</style>
  );
}
