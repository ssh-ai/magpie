//! In-memory pairing/call registry. Mirrors `packages/relay/src/store.ts`.
//!
//! Transport-agnostic: an "endpoint" is an opaque `u64` the relay binds to a
//! socket, so routing "the other endpoint" is exact and cannot be spoofed by a
//! client claiming a different address. Never touches the filesystem; callIds
//! are minted here, rendezvous ids are opaque hex.

use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const DEFAULT_MAX_TURNS: u32 = 12;
pub const ABSOLUTE_MAX_TURNS: u32 = 50;
pub const PAIRING_TTL: Duration = Duration::from_secs(10 * 60); // 10 minutes
pub const CALL_IDLE_TTL: Duration = Duration::from_secs(60 * 60); // 1 hour

/// An endpoint handle (one WebSocket connection).
pub type Endpoint = u64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CallState {
    Open,
    Answered,
    Closed,
}

/// A rendezvous awaiting its second participant.
pub struct Pending {
    pub call_id: String,
    pub from: String,
    pub topic: String,
    pub max_turns: u32,
    pub opener: Endpoint,
    pub created_at: Instant,
}

/// A live, paired call between exactly two endpoints.
#[derive(Clone, Debug)]
pub struct LiveCall {
    pub call_id: String,
    pub topic: String,
    /// [opener, joiner] extension addresses.
    pub participants: [String; 2],
    /// [opener, joiner] endpoints.
    pub endpoints: [Endpoint; 2],
    pub state: CallState,
    pub turn: u32,
    pub max_turns: u32,
    pub created_at: Instant,
    pub updated_at: Instant,
}

/// Stable, machine-readable error codes carried on `{ t:"error" }` frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegError {
    UnknownRendezvous,
    Expired,
    AlreadyPaired,
    TurnCap,
    UnknownCall,
    NotParticipant,
    CallClosed,
    PeerGone,
}

impl RegError {
    pub fn code(self) -> &'static str {
        match self {
            RegError::UnknownRendezvous => "UNKNOWN_RENDEZVOUS",
            RegError::Expired => "EXPIRED",
            RegError::AlreadyPaired => "ALREADY_PAIRED",
            RegError::TurnCap => "TURN_CAP",
            RegError::UnknownCall => "UNKNOWN_CALL",
            RegError::NotParticipant => "NOT_PARTICIPANT",
            RegError::CallClosed => "CALL_CLOSED",
            RegError::PeerGone => "PEER_GONE",
        }
    }
    pub fn message(self) -> &'static str {
        match self {
            RegError::UnknownRendezvous => "no such rendezvous (unknown, expired, or already paired)",
            RegError::Expired => "pairing code expired",
            RegError::AlreadyPaired => "rendezvous already has a pending opener",
            RegError::TurnCap => "turn cap reached",
            RegError::UnknownCall => "no such call",
            RegError::NotParticipant => "sender is not a participant in this call",
            RegError::CallClosed => "call is closed",
            RegError::PeerGone => "the other endpoint is no longer connected",
        }
    }
}

/// Clamp a caller-requested turn cap into `[1, ABSOLUTE_MAX_TURNS]`.
pub fn clamp_max_turns(requested: Option<u32>) -> u32 {
    requested.unwrap_or(DEFAULT_MAX_TURNS).clamp(1, ABSOLUTE_MAX_TURNS)
}

/// Mint a fresh callId matching the TS `newCallId` shape: `call-<nanoid>`.
pub fn new_call_id() -> String {
    format!("call-{}", nanoid::nanoid!())
}

pub struct CallRegistry {
    pending: HashMap<String, Pending>, // keyed by rendezvousId
    calls: HashMap<String, LiveCall>,  // keyed by callId
    pairing_ttl: Duration,
    idle_ttl: Duration,
}

impl CallRegistry {
    pub fn new(pairing_ttl: Duration, idle_ttl: Duration) -> Self {
        Self { pending: HashMap::new(), calls: HashMap::new(), pairing_ttl, idle_ttl }
    }

    /// Register an opener at a rendezvous. Returns the minted callId.
    pub fn open(
        &mut self,
        rendezvous_id: String,
        from: String,
        topic: String,
        max_turns: u32,
        opener: Endpoint,
    ) -> Result<String, RegError> {
        self.expire_pending();
        if self.pending.contains_key(&rendezvous_id) {
            return Err(RegError::AlreadyPaired);
        }
        let call_id = new_call_id();
        self.pending.insert(
            rendezvous_id,
            Pending { call_id: call_id.clone(), from, topic, max_turns, opener, created_at: Instant::now() },
        );
        Ok(call_id)
    }

    /// Second participant consumes the rendezvous, promoting it to a live call.
    pub fn join(
        &mut self,
        rendezvous_id: String,
        from: String,
        joiner: Endpoint,
    ) -> Result<LiveCall, RegError> {
        self.expire_pending();
        let pending = self.pending.get(&rendezvous_id).ok_or(RegError::UnknownRendezvous)?;
        if pending.created_at.elapsed() > self.pairing_ttl {
            self.pending.remove(&rendezvous_id);
            return Err(RegError::Expired);
        }
        // Single-use: consume the rendezvous so no third party can join.
        let pending = self.pending.remove(&rendezvous_id).unwrap();
        let now = Instant::now();
        let call = LiveCall {
            call_id: pending.call_id,
            topic: pending.topic,
            participants: [pending.from, from],
            endpoints: [pending.opener, joiner],
            state: CallState::Open,
            turn: 0,
            max_turns: pending.max_turns,
            created_at: now,
            updated_at: now,
        };
        self.calls.insert(call.call_id.clone(), call.clone());
        Ok(call)
    }

    pub fn get_call(&self, call_id: &str) -> Option<&LiveCall> {
        self.calls.get(call_id)
    }

    /// Account for a delivered message. Increments the turn counter and enforces
    /// the cap. The relay can't read the sealed payload, so it counts every
    /// delivered `send` as one turn — the strongest cap it can enforce.
    pub fn consume_query_turn(&mut self, call_id: &str) -> Result<(), RegError> {
        let call = self.calls.get_mut(call_id).ok_or(RegError::UnknownCall)?;
        if call.turn >= call.max_turns {
            call.state = CallState::Closed;
            return Err(RegError::TurnCap);
        }
        call.turn += 1;
        call.state = CallState::Answered;
        call.updated_at = Instant::now();
        Ok(())
    }

    /// Close + remove a call. Returns the removed call (for routing a hangup).
    pub fn close(&mut self, call_id: &str) -> Option<LiveCall> {
        self.calls.remove(call_id).map(|mut c| {
            c.state = CallState::Closed;
            c
        })
    }

    /// Drop every pending/live state owned by an endpoint (on disconnect).
    /// Returns the calls that were closed (so peers can be notified).
    pub fn drop_endpoint(&mut self, endpoint: Endpoint) -> Vec<LiveCall> {
        self.pending.retain(|_, p| p.opener != endpoint);
        let ids: Vec<String> = self
            .calls
            .iter()
            .filter(|(_, c)| c.endpoints[0] == endpoint || c.endpoints[1] == endpoint)
            .map(|(id, _)| id.clone())
            .collect();
        let mut closed = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(mut c) = self.calls.remove(&id) {
                c.state = CallState::Closed;
                closed.push(c);
            }
        }
        closed
    }

    /// Reap idle calls and expired pendings. Returns the calls that were reaped.
    pub fn reap(&mut self) -> Vec<LiveCall> {
        self.expire_pending();
        let ids: Vec<String> = self
            .calls
            .iter()
            .filter(|(_, c)| c.updated_at.elapsed() > self.idle_ttl)
            .map(|(id, _)| id.clone())
            .collect();
        let mut reaped = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(mut c) = self.calls.remove(&id) {
                c.state = CallState::Closed;
                reaped.push(c);
            }
        }
        reaped
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
    pub fn call_count(&self) -> usize {
        self.calls.len()
    }

    fn expire_pending(&mut self) {
        let ttl = self.pairing_ttl;
        self.pending.retain(|_, p| p.created_at.elapsed() <= ttl);
    }
}

/// The peer endpoint within a call relative to `self_ep`, or None if not a member.
pub fn peer_of(call: &LiveCall, self_ep: Endpoint) -> Option<Endpoint> {
    if call.endpoints[0] == self_ep {
        Some(call.endpoints[1])
    } else if call.endpoints[1] == self_ep {
        Some(call.endpoints[0])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg() -> CallRegistry {
        CallRegistry::new(PAIRING_TTL, CALL_IDLE_TTL)
    }

    #[test]
    fn clamp_bounds() {
        assert_eq!(clamp_max_turns(None), DEFAULT_MAX_TURNS);
        assert_eq!(clamp_max_turns(Some(0)), 1);
        assert_eq!(clamp_max_turns(Some(9999)), ABSOLUTE_MAX_TURNS);
        assert_eq!(clamp_max_turns(Some(5)), 5);
    }

    #[test]
    fn open_then_join_pairs_two_endpoints() {
        let mut r = reg();
        let cid = r.open("a".repeat(32), "@a/x".into(), "t".into(), 12, 1).unwrap();
        assert_eq!(r.pending_count(), 1);
        let call = r.join("a".repeat(32), "@b/y".into(), 2).unwrap();
        assert_eq!(call.call_id, cid);
        assert_eq!(call.endpoints, [1, 2]);
        assert_eq!(call.participants, ["@a/x", "@b/y"]);
        assert_eq!(r.pending_count(), 0);
        assert_eq!(r.call_count(), 1);
    }

    #[test]
    fn double_open_same_rendezvous_is_already_paired() {
        let mut r = reg();
        r.open("a".repeat(32), "@a/x".into(), "t".into(), 12, 1).unwrap();
        let err = r.open("a".repeat(32), "@c/z".into(), "t".into(), 12, 3).unwrap_err();
        assert_eq!(err, RegError::AlreadyPaired);
    }

    #[test]
    fn join_unknown_rendezvous_errors() {
        let mut r = reg();
        assert_eq!(r.join("b".repeat(32), "@b/y".into(), 2).unwrap_err(), RegError::UnknownRendezvous);
    }

    #[test]
    fn turn_cap_after_max_turns() {
        let mut r = reg();
        r.open("a".repeat(32), "@a/x".into(), "t".into(), 2, 1).unwrap();
        let call = r.join("a".repeat(32), "@b/y".into(), 2).unwrap();
        // maxTurns = 2: two sends succeed, the third caps.
        assert!(r.consume_query_turn(&call.call_id).is_ok());
        assert!(r.consume_query_turn(&call.call_id).is_ok());
        assert_eq!(r.consume_query_turn(&call.call_id).unwrap_err(), RegError::TurnCap);
    }

    #[test]
    fn drop_endpoint_closes_its_calls() {
        let mut r = reg();
        r.open("a".repeat(32), "@a/x".into(), "t".into(), 12, 1).unwrap();
        let call = r.join("a".repeat(32), "@b/y".into(), 2).unwrap();
        let closed = r.drop_endpoint(1);
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].call_id, call.call_id);
        assert_eq!(r.call_count(), 0);
    }

    #[test]
    fn peer_of_resolves_other_endpoint() {
        let mut r = reg();
        r.open("a".repeat(32), "@a/x".into(), "t".into(), 12, 1).unwrap();
        let call = r.join("a".repeat(32), "@b/y".into(), 2).unwrap();
        assert_eq!(peer_of(&call, 1), Some(2));
        assert_eq!(peer_of(&call, 2), Some(1));
        assert_eq!(peer_of(&call, 9), None);
    }
}
