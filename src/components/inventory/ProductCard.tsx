'use client'

import Link from 'next/link'
import { Images } from 'lucide-react'
import type { InventoryItem } from '@/lib/inventory/constants'
import { formatPrice, readyShort, readyState, sortedImages } from '@/lib/inventory/format'
import { Pic, StageBadge, StockBadge } from './parts'
import s from './inventory.module.css'

export function ProductCard({ item, toUrl, priority = false }: { item: InventoryItem; toUrl: (path: string) => string; priority?: boolean }) {
  const imgs = sortedImages(item)
  const late = readyState(item).kind === 'overdue'
  return (
    <Link href={`/inventory/${item.id}`} className={`${s.card}${item.qty_available <= 0 ? ` ${s.cardOut}` : ''}`} aria-label={`${item.name}, ${item.product_code}`}>
      <div className={s.cardImg}>
        <Pic src={imgs[0] ? toUrl(imgs[0].path) : null} alt={item.name} eager={priority} />
        <StageBadge stage={item.stage} className={s.cardStage} />
        {imgs.length > 1 && <span className={s.cardPics}><Images size={12} aria-hidden="true" />{imgs.length}</span>}
      </div>
      <div className={s.cardBody}>
        <span className={s.cardCode}>{item.product_code}</span>
        <span className={s.cardName}>{item.name}</span>
        <span className={s.cardMeta}>{item.size_text} · {item.material}</span>
        <div className={s.cardFoot}>
          <span className={s.priceStack}>
            <span className={s.price}>{formatPrice(item.retail_price)}<span className={s.priceTag}>Retail</span></span>
            <span className={s.priceStd}>{formatPrice(item.price)}<span className={s.priceTag}>Standard</span></span>
          </span>
          <StockBadge item={item} />
        </div>
        {item.stage !== 'ready' && <span className={`${s.cardReady}${late ? ` ${s.late}` : ''}`}>{readyShort(item)}</span>}
      </div>
    </Link>
  )
}

export function ProductCardSkeleton() {
  return (
    <div className={s.skelCard} aria-hidden="true">
      <div className={s.skel} style={{ aspectRatio: '4 / 3', borderRadius: 0 }} />
      <div style={{ padding: '10px 12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className={s.skel} style={{ height: 11, width: '35%' }} />
        <div className={s.skel} style={{ height: 15, width: '85%' }} />
        <div className={s.skel} style={{ height: 12, width: '60%' }} />
        <div className={s.skel} style={{ height: 20, width: '50%', marginTop: 6 }} />
      </div>
    </div>
  )
}
