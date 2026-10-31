-- Add the explicitly defined read-only auditor role.
-- This migration changes role validity only; it does not create/promote any operator.
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_role_check;
ALTER TABLE operators
  ADD CONSTRAINT operators_role_check
  CHECK (role IN ('operator','management','auditor','super_admin'));

-- Default-deny role assignment remains enforced by the existing authenticated
-- operator-management workflow. No public/API role grant is introduced here.
