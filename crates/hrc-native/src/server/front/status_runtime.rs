//! Status probes and an observed scheduler-lag window (never synthetic zeroes).
use super::*;
use std::{collections::VecDeque, time::Duration};
#[derive(Default)]
pub struct Lag {
    buckets: VecDeque<(i64, f64, String)>,
    stalls: u64,
    last: Option<Value>,
}
impl Lag {
    pub fn snapshot(&mut self) -> Value {
        let now = chrono::Utc::now().timestamp_millis();
        while self.buckets.front().is_some_and(|b| b.0 <= now - 300_000) {
            self.buckets.pop_front();
        }
        let max = self.buckets.iter().max_by(|a, b| a.1.total_cmp(&b.1));
        let mut v = json!({"intervalMs":250,"stallThresholdMs":1000,"windowMs":300000,"maxLagMs":max.map_or(0.0,|b|b.1.round()) as u64});
        if let Some(b) = max {
            v["maxLagAt"] = b.2.clone().into();
        }
        v["stallCount"] = self.stalls.into();
        if let Some(last) = &self.last {
            v["lastStall"] = last.clone();
        }
        v
    }
}
pub fn start(server: &Shared) {
    let weak = Arc::downgrade(server);
    tokio::spawn(async move {
        loop {
            let expected = Instant::now() + Duration::from_millis(250);
            tokio::time::sleep_until(expected.into()).await;
            let Some(server) = weak.upgrade() else {
                break;
            };
            let lag = Instant::now()
                .saturating_duration_since(expected)
                .as_secs_f64()
                * 1000.0;
            let now = chrono::Utc::now().timestamp_millis();
            let at = timestamp();
            let mut state = server.event_loop.lock().unwrap();
            let bucket = now - now % 60_000;
            if let Some(last) = state.buckets.back_mut().filter(|b| b.0 == bucket) {
                if lag > last.1 {
                    last.1 = lag;
                    last.2 = at.clone();
                }
            } else {
                state.buckets.push_back((bucket, lag, at.clone()));
            }
            if lag >= 1000.0 {
                state.stalls += 1;
                state.last = Some(json!({"at":at,"lagMs":lag.round() as u64,"activities":[]}));
            }
        }
    });
}
pub async fn tmux() -> Value {
    let mut command = tokio::process::Command::new("tmux");
    command.arg("-V").kill_on_drop(true);
    let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(5), command.output()).await else {
        return json!({"available":false});
    };
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let Some(raw) = text.split_whitespace().skip_while(|v| *v != "tmux").nth(1) else {
        return json!({"available":false});
    };
    let Some((major, minor)) = raw.split_once('.') else {
        return json!({"available":false});
    };
    let (Ok(major), Ok(minor)) = (
        major.parse::<u32>(),
        minor
            .trim_end_matches(|c: char| !c.is_ascii_digit())
            .parse::<u32>(),
    ) else {
        return json!({"available":false});
    };
    json!({"available":out.status.success() && (major>3 || major==3 && minor>=2),"version":raw})
}
