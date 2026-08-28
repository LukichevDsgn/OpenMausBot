import { useReducer, type ReactNode } from "react";
import { reducer, StaticStoreProvider, type AppState, type StreamState } from "@/state/store";
import { createFixtureState } from "./fixtures";

export function StorybookProvider({
  children,
  state = createFixtureState(),
  stream = { streaming: {}, reasoning: {} },
}: {
  children: ReactNode;
  state?: AppState;
  stream?: StreamState;
}) {
  const [currentState, dispatch] = useReducer(reducer, state);
  return (
    <StaticStoreProvider state={currentState} dispatch={dispatch} stream={stream}>
      {children}
    </StaticStoreProvider>
  );
}

