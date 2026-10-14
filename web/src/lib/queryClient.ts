import { QueryClient } from "@tanstack/react-query"

// The cache settings of the original client: data stays fresh until a
// mutation invalidates it, and nothing retries or refetches by itself.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
})
