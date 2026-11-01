-- Expand the liveness event vocabulary to cover spoofing, synthetic media,
-- document authenticity, randomized challenge signals and human review.
-- Existing rows are preserved; this changes only the allowed check_key values.
ALTER TABLE avcu_liveness_check_events
  DROP CONSTRAINT IF EXISTS avcu_liveness_check_events_check;

ALTER TABLE avcu_liveness_check_events
  ADD CONSTRAINT avcu_liveness_check_events_check
  CHECK (check_key IN (
    'active_challenge',
    'randomized_motion_challenge',
    'blink_eye_movement',
    'passive_liveness',
    'presentation_attack_detection',
    'photo_screen_spoof_detection',
    'deepfake_detection',
    'replay_detection',
    'camera_injection_detection',
    'device_integrity',
    'session_binding',
    'face_match',
    'document_face_consistency',
    'document_authenticity',
    'capture_quality',
    'risk_fusion',
    'manual_review'
  ));
