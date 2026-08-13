export function movePageBefore(pageOrder, sourcePage, targetPage) {
  if (sourcePage === targetPage) return [...pageOrder];
  const nextOrder = pageOrder.filter((page) => page !== sourcePage);
  const targetIndex = nextOrder.indexOf(targetPage);
  if (targetIndex < 0) return [...pageOrder];
  nextOrder.splice(targetIndex, 0, sourcePage);
  return nextOrder;
}
