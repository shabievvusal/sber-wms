import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DatePicker } from '@/components/ui/date-picker'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Settings2 } from 'lucide-react'
import { DOC_KIND_LABEL, todayStr, getSupervisors, saveSupervisors, buildOutput, DOC_PRINT_STYLES } from './builders'

// Перенесено «точь-в-точь» из оригинала (frontend/app/src/pages/docs/DocsPage.jsx)
// — тот же набор полей/вкладок/действий, тот же генератор документов, тот же
// список «Начальники смен» в localStorage (ключ `memos_supervisors`, общий с
// ConsolidationPage). Единственная замена — технические примитивы (shadcn
// Input/Button/DatePicker вместо самодельных CSS-классов), не сам функционал.

const selectClass = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

const KIND_TABS = [
  { key: 'bidu', label: 'Служебная: BIDU' },
  { key: 'surplus', label: 'Служебная: Излишки' },
  { key: 'tc', label: 'Служебная ТС' },
  { key: 'exp', label: 'Объяснительная' },
]

function Field({ label, children }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  )
}

export default function DocsPage() {
  const today = todayStr()

  const [kind, setKind] = useState('bidu')
  const [showSettings, setShowSettings] = useState(false)
  const [supervisors, setSupervisors] = useState(() => getSupervisors())
  const [supervisorInput, setSupervisorInput] = useState('')
  const [copyLabel, setCopyLabel] = useState('Скопировать')

  // Общие поля
  const [date, setDate] = useState(today)
  const [role, setRole] = useState('receiving')
  const [fio, setFio] = useState('')
  const [fioGen, setFioGen] = useState('')
  const [product, setProduct] = useState('')
  const [article, setArticle] = useState('')
  const [quantity, setQuantity] = useState('')
  const [eo, setEo] = useState('')
  const [authorSelect, setAuthorSelect] = useState('')
  const [author, setAuthor] = useState('')
  const [authorRole, setAuthorRole] = useState('')

  // Поля ТС
  const [tcCompany, setTcCompany] = useState('')
  const [tcViolator, setTcViolator] = useState('')
  const [tcTaskArea, setTcTaskArea] = useState('storage')
  const [tcProduct, setTcProduct] = useState('')
  const [tcArticle, setTcArticle] = useState('')
  const [tcQuantity, setTcQuantity] = useState('')
  const [tcPlace, setTcPlace] = useState('')
  const [tcEo, setTcEo] = useState('')
  const [tcTime, setTcTime] = useState('')
  const [tcDateIncident, setTcDateIncident] = useState(today)
  const [tcDateMemo, setTcDateMemo] = useState(today)
  const [tcBrigadier, setTcBrigadier] = useState('')

  // Поля объяснительной
  const [expOp, setExpOp] = useState('')
  const [expIssue, setExpIssue] = useState('')
  const [expReason1, setExpReason1] = useState('')
  const [expReason2, setExpReason2] = useState('')
  const [expMeasures, setExpMeasures] = useState('')

  const fields = {
    date, role, fio, fioGen, product, article, quantity, eo, author, authorRole,
    tcCompany, tcViolator, tcTaskArea, tcProduct, tcArticle, tcQuantity,
    tcPlace, tcEo, tcTime, tcDateIncident, tcDateMemo, tcBrigadier,
    expOp, expIssue, expReason1, expReason2, expMeasures,
  }

  const { html: outputHtml, text: outputText } = buildOutput(kind, fields)

  const addSupervisor = useCallback(() => {
    const name = supervisorInput.trim()
    if (!name) return
    const list = getSupervisors()
    if (list.includes(name)) return
    list.push(name)
    saveSupervisors(list)
    setSupervisors([...list])
    setSupervisorInput('')
  }, [supervisorInput])

  const removeSupervisor = useCallback(idx => {
    const list = getSupervisors()
    list.splice(idx, 1)
    saveSupervisors(list)
    setSupervisors([...list])
  }, [])

  const handleAuthorSelect = val => {
    setAuthorSelect(val)
    if (val) { setAuthor(val); setAuthorRole('Начальник смены') }
  }

  const handleClear = () => {
    setFio(''); setFioGen(''); setProduct(''); setArticle(''); setQuantity(''); setEo('')
    setAuthorSelect(''); setAuthor(''); setAuthorRole('')
    setTcCompany(''); setTcViolator(''); setTcProduct(''); setTcArticle('')
    setTcQuantity(''); setTcPlace(''); setTcEo(''); setTcTime(''); setTcBrigadier('')
    setTcTaskArea('storage')
    setExpOp(''); setExpIssue(''); setExpReason1(''); setExpReason2(''); setExpMeasures('')
    const t = todayStr()
    setDate(t); setTcDateIncident(t); setTcDateMemo(t)
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(outputText.trim()).then(() => {
      setCopyLabel('Скопировано')
      setTimeout(() => setCopyLabel('Скопировать'), 1200)
    })
  }

  const handlePrint = () => {
    const win = window.open('', '_blank', 'width=900,height=700')
    if (!win) { toast.error('Разрешите всплывающие окна для печати'); return }
    win.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Документ</title><style>${DOC_PRINT_STYLES}</style></head><body>${outputHtml}</body></html>`)
    win.document.close()
    win.focus()
    win.print()
  }

  const handleDownload = () => {
    const htmlDoc = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Документ</title><style>${DOC_PRINT_STYLES}</style></head><body>${outputHtml}</body></html>`
    const blob = new Blob([htmlDoc], { type: 'application/msword' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `документ_${kind}_${date || 'без_даты'}.doc`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const isCommon = kind !== 'tc'
  const isExp = kind === 'exp'
  const isTc = kind === 'tc'

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Служебные записки и объяснительные</h1>
          <p className="text-sm text-muted-foreground">Шаблоны с привязкой к должностным инструкциям (разделы 3 и 5 ДИ)</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setShowSettings(v => !v)}><Settings2 className="size-3.5" /> Настройки</Button>
          <Button size="sm" variant="secondary" onClick={handleClear}>Очистить</Button>
          <Button size="sm" variant="outline" onClick={handleCopy}>{copyLabel}</Button>
          <Button size="sm" variant="secondary" onClick={handlePrint}>Печать</Button>
          <Button size="sm" onClick={handleDownload}>Скачать Word (.doc)</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Левая колонка — форма */}
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle>Параметры документа</CardTitle>
            <span className="text-sm text-muted-foreground">{DOC_KIND_LABEL[kind]}</span>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-1.5 rounded-md border bg-muted/30 p-1">
              {KIND_TABS.map(t => (
                <Button key={t.key} size="sm" variant={kind === t.key ? 'default' : 'ghost'} onClick={() => setKind(t.key)}>
                  {t.label}
                </Button>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Дата">
                <DatePicker value={date} onChange={e => setDate(e.target.value)} />
              </Field>
              <Field label="Должность">
                <select className={selectClass} value={role} onChange={e => setRole(e.target.value)}>
                  <option value="receiving">Кладовщик (участок приема)</option>
                  <option value="placement">Кладовщик (участок размещения)</option>
                  <option value="forklift">Водитель погрузчика (участок размещения)</option>
                </select>
              </Field>
            </div>

            {isCommon && (
              <div className="space-y-3">
                <Field label="ФИО сотрудника">
                  <Input placeholder="Иванов Иван Иванович" value={fio} onChange={e => setFio(e.target.value)} />
                </Field>
                <Field label="ФИО в родительном падеже (опционально)">
                  <Input placeholder="Иванова Ивана Ивановича" value={fioGen} onChange={e => setFioGen(e.target.value)} />
                </Field>
                <Field label="Наименование товара">
                  <Input placeholder="Товар" value={product} onChange={e => setProduct(e.target.value)} />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Артикул">
                    <Input placeholder="УТ-00000000" value={article} onChange={e => setArticle(e.target.value)} />
                  </Field>
                  <Field label="Количество">
                    <Input placeholder="1" value={quantity} onChange={e => setQuantity(e.target.value)} />
                  </Field>
                </div>
                <Field label="ЕО">
                  <Input placeholder="323100000000" value={eo} onChange={e => setEo(e.target.value)} />
                </Field>
              </div>
            )}

            {isTc && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">Служебная записка о некорректной комплектации (по образцу ТС).</p>
                <Field label="Компания сотрудников">
                  <Input placeholder='ООО «2 Колеса»' value={tcCompany} onChange={e => setTcCompany(e.target.value)} />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="ФИО нарушителя">
                    <Input placeholder="Ходжамуродов Абдулло Зиёвиддинович" value={tcViolator} onChange={e => setTcViolator(e.target.value)} />
                  </Field>
                  <Field label="Где выполнял задачу">
                    <select className={selectClass} value={tcTaskArea} onChange={e => setTcTaskArea(e.target.value)}>
                      <option value="storage">В хранении</option>
                      <option value="kdk">В КДК</option>
                    </select>
                  </Field>
                </div>
                <Field label="Наименование товара">
                  <Input placeholder="Суп-пюре..." value={tcProduct} onChange={e => setTcProduct(e.target.value)} />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="УТ (артикул)">
                    <Input placeholder="УТ-00201035" value={tcArticle} onChange={e => setTcArticle(e.target.value)} />
                  </Field>
                  <Field label="Количество, шт">
                    <Input placeholder="8" value={tcQuantity} onChange={e => setTcQuantity(e.target.value)} />
                  </Field>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Место">
                    <Input placeholder="Ячейка / адрес" value={tcPlace} onChange={e => setTcPlace(e.target.value)} />
                  </Field>
                  <Field label="ЕО">
                    <Input placeholder="01220014-2109" value={tcEo} onChange={e => setTcEo(e.target.value)} />
                  </Field>
                </div>
                <Field label="Время (опционально)">
                  <Input placeholder="14:30" value={tcTime} onChange={e => setTcTime(e.target.value)} />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Дата нарушения">
                    <DatePicker value={tcDateIncident} onChange={e => setTcDateIncident(e.target.value)} />
                  </Field>
                  <Field label="Дата служебной записки">
                    <DatePicker value={tcDateMemo} onChange={e => setTcDateMemo(e.target.value)} />
                  </Field>
                </div>
                <Field label="Бригадир (для блока ознакомления)">
                  <Input placeholder='Бригадир ООО «2 Колеса»' value={tcBrigadier} onChange={e => setTcBrigadier(e.target.value)} />
                </Field>
              </div>
            )}

            {isExp && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">Объяснительная заполняется от лица сотрудника.</p>
                <Field label="Операция/этап">
                  <Input placeholder="Приемка/размещение/сборка отправления" value={expOp} onChange={e => setExpOp(e.target.value)} />
                </Field>
                <Field label="Суть ошибки">
                  <Textarea placeholder="Кратко опишите, что было сделано неверно" value={expIssue} onChange={e => setExpIssue(e.target.value)} />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Причина 1">
                    <Input placeholder="Невнимательность при сканировании" value={expReason1} onChange={e => setExpReason1(e.target.value)} />
                  </Field>
                  <Field label="Причина 2">
                    <Input placeholder="Высокая нагрузка в смене" value={expReason2} onChange={e => setExpReason2(e.target.value)} />
                  </Field>
                </div>
                <Field label="Меры недопущения (по одной строке)">
                  <Textarea placeholder={'Проверка ЕО перед подтверждением\nПовторная сверка по ТСД'} value={expMeasures} onChange={e => setExpMeasures(e.target.value)} />
                </Field>
              </div>
            )}

            <div className="space-y-3 border-t pt-3">
              <Field label="Начальник смены (составил)">
                <select className={selectClass} value={authorSelect} onChange={e => handleAuthorSelect(e.target.value)}>
                  <option value="">— Выберите или введите ниже —</option>
                  {supervisors.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="ФИО составителя">
                  <Input placeholder="Петров П.П." value={author} onChange={e => setAuthor(e.target.value)} />
                </Field>
                <Field label="Должность составителя">
                  <Input placeholder="Начальник смены" value={authorRole} onChange={e => setAuthorRole(e.target.value)} />
                </Field>
              </div>
            </div>

            {showSettings && (
              <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                <div className="font-semibold">Начальники смен</div>
                <p className="text-sm text-muted-foreground">Добавьте ФИО — они появятся в списке выбора выше, чтобы не вводить каждый раз.</p>
                <ul className="space-y-1.5">
                  {supervisors.map((name, i) => (
                    <li key={i} className="flex items-center justify-between rounded-md bg-card px-3 py-1.5 text-sm">
                      <span>{name}</span>
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => removeSupervisor(i)}>× Удалить</Button>
                    </li>
                  ))}
                </ul>
                <div className="flex items-end gap-2">
                  <Field label="ФИО начальника смены">
                    <Input
                      placeholder="Иванов И.И."
                      value={supervisorInput}
                      onChange={e => setSupervisorInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSupervisor() } }}
                    />
                  </Field>
                  <Button onClick={addSupervisor}>Добавить</Button>
                </div>
              </div>
            )}

            <Button className="w-full" onClick={() => {}}>Сформировать документ</Button>
          </CardContent>
        </Card>

        {/* Правая колонка — предпросмотр */}
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle>Результат</CardTitle>
            <span className="text-sm text-muted-foreground">Готово к вставке в Word/почту</span>
          </CardHeader>
          <CardContent>
            <div className="overflow-auto rounded-md bg-muted/40 p-4">
              <div
                className="mx-auto min-h-[297mm] w-[210mm] max-w-full bg-white p-[20mm] text-black shadow"
                style={{ fontFamily: '"Times New Roman", serif', fontSize: '12pt', lineHeight: 1.45 }}
                dangerouslySetInnerHTML={{ __html: outputHtml }}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
