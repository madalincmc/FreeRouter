import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { IpcChannel, IpcContract, IpcEvent, IpcEvents } from '@shared/ipc'

export function invoke<C extends IpcChannel>(
  channel: C,
  ...args: IpcContract[C]['args']
): Promise<IpcContract[C]['result']> {
  return window.freerouter.invoke(channel, ...args)
}

type ReadChannel = { [K in IpcChannel]: IpcContract[K]['args'] extends [] ? K : never }[IpcChannel]

/** TanStack Query wrapper for argument-less IPC reads. */
export function useIpcQuery<C extends ReadChannel>(channel: C) {
  const call = window.freerouter.invoke as (c: C) => Promise<IpcContract[C]['result']>
  return useQuery({ queryKey: [channel], queryFn: () => call(channel) })
}

/** Mutation that writes its result straight into the matching query's cache. */
export function useIpcMutation<C extends IpcChannel>(channel: C, updatesQuery?: IpcChannel) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: IpcContract[C]['args']) => invoke(channel, ...args),
    onSuccess: (result) => {
      if (updatesQuery) qc.setQueryData([updatesQuery], result)
    }
  })
}

export function useIpcEvent<E extends IpcEvent>(event: E, listener: (payload: IpcEvents[E]) => void): void {
  useEffect(() => window.freerouter.on(event, listener), [event, listener])
}
