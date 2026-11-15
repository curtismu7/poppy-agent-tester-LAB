// Prev / Next and one dot per page, at the bottom of every page of the Run it tab.
export default function Pager({ page, pages, onPage }) {
  const last = pages.length;
  return (
    <nav className="pager" aria-label="Run it pages">
      {page > 1 ? <button type="button" onClick={() => onPage(page - 1)} data-testid="pager-prev">&larr; {pages[page - 2]}</button> : <span />}
      <span className="pager__dots">
        {pages.map((name, i) => (
          <button key={name} type="button" className="pager__dot" aria-label={`Page ${i + 1} of ${last}: ${name}`} aria-current={page === i + 1 ? "page" : undefined} onClick={() => onPage(i + 1)} />
        ))}
      </span>
      {page < last ? <button type="button" className="primary" onClick={() => onPage(page + 1)} data-testid="pager-next">Next: {pages[page]} &rarr;</button> : <span />}
    </nav>
  );
}
