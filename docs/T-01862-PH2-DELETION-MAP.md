# T-01862 Ph2 deletion map — ad-hoc hosting reads → runtime-hosting.ts choke point

Built 2026-06-04 (Explore audit) for the Ph1-green review gate (daedalus) and as the Ph2 (T-01873)
impl brief. Proves `broker/runtime-hosting.ts` is a real choke point: these are the ad-hoc
transport/runtimeStateJson reads Ph2 routes through `parseBrokerRuntimeHostingState` + predicates,
not a parallel parser nobody uses.

Choke-point API (Ph1): parseBrokerRuntimeHostingState, requireBrokerRuntimeHostingState,
hasDurableBrokerEndpoint, hasLeasedBrokerSubstrate, hasBrokerPresentation, canOperatorAttach,
canUseDirectPaneFallback, brokerLeaseIdentityMatches.

## MUST DELETE (Ph2 routes through choke point) — ~hosting/durability decisions
```
startup-reconcile.ts:141              transport==='tmux' durability branch        → hasDurableBrokerEndpoint
startup-reconcile.ts:235-239          transport==='tmux' + extractRuntimeControlState degraded read
startup-reconcile.ts:282              getBrokerRuntimeTmuxSocketPath (substrate)
startup-reconcile.ts:314              brokerLeaseWindowsMatch (identity)           → brokerLeaseIdentityMatches
startup-reconcile.ts:391              transport!=='tmux' sweep socket filter
startup-reconcile.ts:808-815          transport!=='tmux' orphan-sweep claimed-lease filter (also Ph4 G3/sweeper)
startup-reconcile.ts:880-955          getPersistedBrokerWindows + brokerLeaseIdsMatch/brokerLeaseWindowsMatch
                                       + direct tmuxJson session/window/pane reads → fold into brokerLeaseIdentityMatches
runtime-io-handlers.ts:75-84          extractRuntimeControlState degraded-mode read
runtime-io-handlers.ts:140-145        direct tmuxJson.paneId read
sweep-reconcile.ts:433,457            transport==='headless' durability checks
sweep-reconcile.ts:515-535            transport==='tmux' + direct inspectSession
broker-interactive-handlers.ts:505-513 getBrokerRuntimeTmuxSocketPath + brokerLeaseIdsMatch (presentation-gated fallback)
turn-dispatch-handlers.ts:313-314     transport==='tmux' && getBrokerRuntimeTmuxSocketPath durability check
target-message-handlers.ts:190-191    transport==='tmux' && getBrokerRuntimeTmuxSocketPath durability check
runtime-list-adopt-handlers.ts:111    getBrokerRuntimeTmuxSocketPath substrate read
broker-decisions.ts:671-715           getBrokerRuntimeTmuxSocketPath/SessionName/AttachTarget (substrate+presentation)
broker/runtime-state.ts:299-326       extractRuntimeStateTmux deserialize (callers route through choke point;
                                       toBrokerTmuxJson/toRuntimeStateTmux serialize side STAYS as allocator output)
broker/controller.ts:1481             extractRuntimeStateTmux on durable rebuild
```

## MUST SPLIT (transport branch; tmux/durable arm → choke point, ghostty/legacy arm stays)
```
runtime-control-handlers.ts:280-287   interrupt routing (tmux vs ghostty)
runtime-control-handlers.ts:421-424   termination routing (tmux vs ghostty)
runtime-io-handlers.ts:229-231        liveness routing (tmux vs ghostty)
```

## STAYS (public-API / route-label / reuse filters — NOT hosting decisions)
```
target-view.ts:111-170                capability view, transport labels
runtime-select.ts:27,36,134           route/reuse filter predicates (public interaction semantics)
turn-dispatch-handlers.ts:365         reuse guard
target-message-handlers.ts:197-198,318 filter predicates
```

## Allocator split anchors (Ph2 substrate vs presentation)
`broker/controller.ts` BrokerTmuxAllocator type 289-327; allocateTmuxIfRequired 1505-1566
(builds allocation 1528-1566). Split target:
- SUBSTRATE: socketPath, sessionId/sessionName, windowId/windowName, paneId, brokerWindow, generation, eventLedger
- PRESENTATION: tuiWindow, attachCommand (tmux-tui only)
- ENDPOINT/auth: brokerIpcSocketPath, attachToken/attachTokenRef (always, both presentations)
- diagnostics: brokerCommand, brokerPid
Serialize side (toBrokerTmuxJson/toRuntimeStateTmux, controller 1331/1349) stays as allocator
output; only the READ/deserialize callers move to the choke point.

## Load-bearing-first order for Ph2
1. startup-reconcile.ts (most reads; also feeds Ph4)  2. runtime-io-handlers.ts  3. broker-interactive-handlers.ts
4. sweep-reconcile.ts  5. broker-decisions.ts  6. controller.ts allocator split  7. the dispatch/adopt/target one-liners.
Note: startup-reconcile 808-955 + sweep are also Ph4 (G3 GC-loop replacement, sweeper-by-substrate);
Ph2 only migrates the interactive-path READS onto the choke point, preserving behavior. Ph4 changes behavior.
