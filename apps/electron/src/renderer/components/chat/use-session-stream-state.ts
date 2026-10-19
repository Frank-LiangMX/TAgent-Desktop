import { useCallback, useRef, useState, type SetStateAction } from 'react'
import { EMPTY_STREAM_STATE, type SessionStreamState } from './stream-item-model'

export function useSessionStreamState() {
  const [state, publish] = useState<SessionStreamState>(EMPTY_STREAM_STATE)
  const stateRef = useRef<SessionStreamState>(EMPTY_STREAM_STATE)
  // IPC events are ordered independently of React's rendering batches. A boundary
  // event must see every preceding delta even when no render has committed yet.
  // Never mirror a render snapshot back into this ingestion state.
  const setState = useCallback((update: SetStateAction<SessionStreamState>) => {
    const next = typeof update === 'function' ? update(stateRef.current) : update
    stateRef.current = next
    publish(next)
  }, [])
  return [state, setState, stateRef] as const
}
