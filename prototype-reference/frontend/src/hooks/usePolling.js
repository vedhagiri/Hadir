import { useEffect, useRef, useState } from 'react'

/**
 * Poll an async function every `interval` ms while `active` is true.
 * The function is kept in a ref so changing it doesn't restart the timer.
 */
export function usePolling(fetcher, interval, active) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const fetcherRef = useRef(fetcher)
  useEffect(() => { fetcherRef.current = fetcher }, [fetcher])

  useEffect(() => {
    if (!active) return
    let cancelled = false

    const tick = async () => {
      try {
        const result = await fetcherRef.current()
        if (!cancelled) { setData(result); setError(null) }
      } catch (err) {
        if (!cancelled) setError(err)
      }
    }

    tick()
    const id = setInterval(tick, interval)
    return () => { cancelled = true; clearInterval(id) }
  }, [active, interval])

  return { data, error, refresh: () => fetcherRef.current() }
}