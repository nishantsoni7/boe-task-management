'use client'

// Quotations → Price learning → Upload a batch. Four steps in one page: choose the files, check what was read, the blind test,
// learned. The whole batch lives in this page until "Learn this batch": nothing is saved on the way, and the browser warns
// before the page is left.

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AppLink as Link } from '@/components/ui/AppLink'
import { QuotationsLayout } from '@/components/layout/QuotationsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useQuotations } from '@/hooks/useQuotations'
import { blindTest, typesOf, type BlindTest } from '@/lib/pricing/learning/blindTest'
import { BATCH_FILE_MAX, buildSaveDoc, initialReview, testLinesOf, type ReviewPi, type SeenBefore } from '@/lib/pricing/learning/batch'
import { fetchHome, fetchKnown, learningErrorKind, learningErrorText, learningKeys, saveBatch } from '@/lib/pricing/learning/api'
import { readPiFile, type PiFile } from '@/lib/pricing/learning/piFile'
import type { PiLine } from '@/lib/pricing/learning/readPi'
import { fetchWordsFor } from '@/lib/pricing/features'
import type { ModelPoint } from '@/lib/pricing/model'
import { fetchPool } from '@/lib/pricing/pool'
import { StepCheck, type LineEdit } from './StepCheck'
import { StepFiles, type Progress } from './StepFiles'
import { StepTest } from './StepTest'
import { inNum, isDesk } from './common'
import s from '@/components/quotations/quotations.module.css'
import l from './learning.module.css'

type Step = 'files' | 'check' | 'test' | 'done'
const STEPS: [Step, string][] = [['files', 'Choose files'], ['check', 'Check what was read'], ['test', 'Blind test'], ['done', 'Learned']]
const r2 = (n: number) => Math.round(n * 100) / 100

export default function LearningNew() {
  const { supabase, profile, loading, signOut, access, accessLoaded, notSetUp } = useQuotations()
  const qc = useQueryClient()
  const desk = isDesk(access)
  const [step, setStep] = useState<Step>('files')
  const [clientType, setClientType] = useState('')
  const [files, setFiles] = useState<PiFile[]>([])
  const [seen, setSeen] = useState<SeenBefore[]>([])
  const [progress, setProgress] = useState<Progress>(null)
  const [pis, setPis] = useState<ReviewPi[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [test, setTest] = useState<BlindTest | null>(null)
  const [busy, setBusy] = useState<'testing' | 'saving' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ batch_no: number; pis_learned: number; pis_left_out: number; lines_learned: number } | null>(null)

  // The score of the last batch, for the "against the last batch" comparison.
  const home = useQuery({ queryKey: learningKeys.home, queryFn: () => fetchHome(supabase), enabled: accessLoaded && !notSetUp && desk, retry: false })
  const previous = home.data?.batches.filter(b => b.avg_miss !== null).sort((a, b) => b.batch_no - a.batch_no)[0] ?? null

  // Everything is in this page until it is learned: leaving would lose the checking.
  useEffect(() => {
    if (files.length === 0 || step === 'done') return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [files.length, step])

  const addFiles = async (incoming: File[]) => {
    setError(null)
    const sheets = incoming.filter(f => /\.(xlsx|xls)$/i.test(f.name))
    const room = BATCH_FILE_MAX - files.length
    const take = sheets.slice(0, Math.max(0, room))
    const notes = [
      sheets.length < incoming.length ? `${incoming.length - sheets.length} file${incoming.length - sheets.length === 1 ? ' is' : 's are'} not Excel and ${incoming.length - sheets.length === 1 ? 'was' : 'were'} left out.` : '',
      sheets.length > take.length ? `A batch holds ${BATCH_FILE_MAX} files: ${sheets.length - take.length} more ${sheets.length - take.length === 1 ? 'was' : 'were'} not added. Learn this batch first, then upload the rest.` : '',
    ].filter(Boolean)
    if (take.length === 0) { setError(notes.join(' ') || 'Choose Excel files (.xlsx or .xls).'); return }
    const read: PiFile[] = []
    setProgress({ done: 0, total: take.length })
    for (const [i, f] of take.entries()) {
      read.push(await readPiFile(f))
      setProgress({ done: i + 1, total: take.length })
    }
    const all = [...files, ...read]
    setFiles(all)
    try {
      setSeen(await fetchKnown(supabase, all.map(f => f.fileHash).filter(Boolean), all.map(f => f.contentPrint).filter(Boolean)))
    } catch (e) { notes.push(learningErrorText(e)) }
    setProgress(null)
    if (notes.length) setError(notes.join(' '))
  }

  const start = () => {
    const review = initialReview(files, seen, clientType || null)
    setPis(review); setSelected(review.find(p => p.learn)?.id ?? review[0]?.id ?? null); setStep('check'); setError(null)
  }
  const onClientType = (v: string) => { setClientType(v); setPis(ps => ps.map(p => ({ ...p, clientType: v || null }))) }
  const patchPi = (id: string, patch: Partial<Pick<ReviewPi, 'learn' | 'date' | 'dateSource' | 'clientType'>>) => setPis(ps => ps.map(p => (p.id === id ? { ...p, ...patch, ...(patch.learn === true ? { leftOutReason: null } : patch.learn === false ? { leftOutReason: p.leftOutReason ?? 'Left out while checking' } : {}) } : p)))
  const editLine = (id: string, idx: number, edit: LineEdit) => setPis(ps => ps.map(p => (p.id !== id ? p : {
    ...p, lines: p.lines.map((x, i) => {
      if (i !== idx) return x
      const line: PiLine = { ...x.line, ...edit }
      // The person has looked at this line: the reader's doubts about it are answered.
      return { ...x, line: { ...line, total: r2(line.qty * line.price), flags: [] } }
    }),
  })))
  const keepLine = (id: string, idx: number, keep: boolean) => setPis(ps => ps.map(p => (p.id !== id ? p : { ...p, lines: p.lines.map((x, i) => (i === idx ? { ...x, keep } : x)) })))

  const runTest = async () => {
    setBusy('testing'); setError(null)
    try {
      const lines = testLinesOf(pis)
      const pools = new Map<string, ModelPoint[]>()
      await Promise.all(typesOf(lines).map(async t => { pools.set(t, await fetchPool(supabase, fetchWordsFor(t))) }))
      setTest(blindTest(lines, t => pools.get(t) ?? [], Date.now()))
      setStep('test')
    } catch (e) { setError(learningErrorText(e)) } finally { setBusy(null) }
  }

  const learn = async () => {
    if (!test) return
    setBusy('saving'); setError(null)
    try {
      const r = await saveBatch(supabase, buildSaveDoc(pis, { avg_miss: test.avgMiss, hit_rate: test.hitRate, priced: test.priced, unpriced: test.unpriced }, clientType || null, null))
      setSaved(r); setStep('done')
      void qc.invalidateQueries({ queryKey: ['pricing', 'learning'] })
      // Every suggested price on every open quotation now learns from this batch.
      void qc.invalidateQueries({ queryKey: ['quotations', 'pool'] })
      void qc.invalidateQueries({ queryKey: ['quotations', 'hints'] })
    } catch (e) {
      setError(learningErrorText(e))
      if (learningErrorKind(e) === 'duplicate') setStep('check')
    } finally { setBusy(null) }
  }

  if (loading) return <LoadingScreen />
  const index = STEPS.findIndex(([k]) => k === step)
  return (
    <QuotationsLayout profile={profile} access={access} onSignOut={signOut} title="Upload a batch" subtitle={`Up to ${BATCH_FILE_MAX} PIs at a time`}
      actions={<Link href="/quotations/learning" className={s.btn}>Price learning</Link>}>
      <div className={s.wrap}>
        {notSetUp && <div className={`${s.notice} ${s.noticeWarn}`}><b>Price learning is being set up.</b> Its database part has not been applied yet.</div>}
        {accessLoaded && !desk && <div className={`${s.notice} ${s.noticeWarn}`}><b>Price learning is for the pricing desk.</b></div>}
        {accessLoaded && desk && !notSetUp && (
          <>
            <ol className={l.steps} aria-label="Steps" style={{ listStyle: 'none', padding: 0 }}>
              {STEPS.map(([k, label], i) => (
                <li key={k} className={`${l.step} ${i < index ? l.stepDone : i === index ? l.stepNow : ''}`} aria-current={i === index ? 'step' : undefined}><i>{i < index ? '✓' : i + 1}</i>{label}</li>
              ))}
            </ol>
            {step === 'files' && <StepFiles files={files} seen={seen} progress={progress} error={error} clientType={clientType} onClientType={onClientType}
              onAdd={addFiles} onRemove={i => setFiles(fs => fs.filter((_, k) => k !== i))} onNext={start} />}
            {step === 'check' && <StepCheck pis={pis} selected={selected} busy={busy === 'testing'} error={error} onSelect={setSelected} onPi={patchPi} onEditLine={editLine} onKeep={keepLine}
              onBack={() => { setStep('files'); setError(null) }} onNext={runTest} />}
            {step === 'test' && test && <StepTest test={test} pis={pis} previous={previous ? { avg_miss: previous.avg_miss, hit_rate: previous.hit_rate } : null} saving={busy === 'saving'} error={error}
              onBack={() => { setStep('check'); setError(null) }} onLearn={learn} />}
            {step === 'done' && saved && (
              <section className={s.card}>
                <div className={`${s.cardBody}`} style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
                  <div className={`${s.notice} ${s.noticeOk}`} role="status"><b>Batch {saved.batch_no} is learned.</b> {saved.pis_learned} PI{saved.pis_learned === 1 ? '' : 's'} and {inNum(saved.lines_learned)} lines now count in every suggested price{saved.pis_left_out ? `; ${saved.pis_left_out} left out` : ''}.</div>
                  {test && test.avgMiss !== null && <div>Its blind-test score: an average miss of <b>{test.avgMiss}%</b>{test.hitRate !== null && <>, with {test.hitRate}% of lines within ±10%</>}.</div>}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Link href="/quotations/learning" className={`${s.btn} ${s.btnPrimary}`}>Back to Price learning</Link>
                    <Link href={`/quotations/learning/new?again=${saved.batch_no}`} className={s.btn} onClick={() => { setFiles([]); setPis([]); setSeen([]); setTest(null); setSaved(null); setStep('files') }}>Upload another batch</Link>
                  </div>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </QuotationsLayout>
  )
}
