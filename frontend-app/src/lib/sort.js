// Общая логика для кликабельных заголовков таблиц: desc → asc → без сортировки.
export function toggleSortState(sort, key) {
  if (sort.key === key) {
    const dir = sort.dir === 'desc' ? 'asc' : sort.dir === 'asc' ? null : 'desc'
    return dir === null ? { key: null, dir: null } : { key, dir }
  }
  return { key, dir: 'desc' }
}
