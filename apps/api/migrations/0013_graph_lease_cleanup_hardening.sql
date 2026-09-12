PRAGMA foreign_keys = ON;

-- Retry availability is independent of cleanup ownership because every attempt
-- receives a distinct immutable physical key.
DROP TRIGGER graph_versions_legal_transition;

CREATE TRIGGER graph_versions_legal_transition
BEFORE UPDATE ON graph_versions
WHEN NOT (
  (
    OLD.storage_layout = 'LEGACY_V1' AND NEW.storage_layout = 'LEGACY_V1' AND (
      (OLD.status = 'QUEUED' AND NEW.status = 'BUILDING' AND NEW.attempt = OLD.attempt) OR
      (OLD.status = 'BUILDING' AND NEW.status IN ('FAILED','READY') AND NEW.attempt = OLD.attempt) OR
      (OLD.status = 'FAILED' AND NEW.status = 'QUEUED' AND NEW.attempt = OLD.attempt + 1) OR
      (OLD.status = 'READY' AND NEW.status = 'SUPERSEDED' AND NEW.attempt = OLD.attempt) OR
      (
        OLD.status = 'FAILED' AND NEW.status = 'FAILED' AND NEW.attempt = OLD.attempt AND
        NEW.id IS OLD.id AND NEW.project_id IS OLD.project_id AND NEW.version IS OLD.version AND
        NEW.repository_provider IS OLD.repository_provider AND
        NEW.provider_repository_id IS OLD.provider_repository_id AND
        NEW.repository_owner IS OLD.repository_owner AND NEW.repository_name IS OLD.repository_name AND
        NEW.repository_canonical_url IS OLD.repository_canonical_url AND
        NEW.source_commit_sha IS OLD.source_commit_sha AND NEW.graphify_version IS OLD.graphify_version AND
        NEW.adapter_version IS OLD.adapter_version AND NEW.profile IS OLD.profile AND
        NEW.format_version IS OLD.format_version AND NEW.generator IS OLD.generator AND
        NEW.lease_id IS OLD.lease_id AND NEW.lease_expires_at IS OLD.lease_expires_at AND
        NEW.failure_category IS OLD.failure_category AND NEW.storage_key IS OLD.storage_key AND
        NEW.selected_publication_id IS OLD.selected_publication_id AND NEW.checksum IS OLD.checksum AND
        NEW.byte_size IS OLD.byte_size AND NEW.node_count IS OLD.node_count AND
        NEW.link_count IS OLD.link_count AND NEW.hyperedge_count IS OLD.hyperedge_count AND
        NEW.generated_by IS OLD.generated_by AND NEW.published_attempt IS OLD.published_attempt AND
        NEW.published_lease_id IS OLD.published_lease_id AND NEW.queued_at IS OLD.queued_at AND
        NEW.build_started_at IS OLD.build_started_at AND NEW.failed_at IS OLD.failed_at AND
        NEW.generated_at IS OLD.generated_at AND NEW.superseded_at IS OLD.superseded_at AND
        NEW.updated_at IS OLD.updated_at
      )
    )
  ) OR
  (
    OLD.storage_layout = 'ATTEMPT_V2' AND NEW.storage_layout = 'ATTEMPT_V2' AND (
      (
        OLD.status = 'QUEUED' AND NEW.status = 'BUILDING' AND NEW.attempt = OLD.attempt AND
        EXISTS (
          SELECT 1 FROM graph_build_attempts gba
          WHERE gba.project_id = NEW.project_id AND gba.graph_version = NEW.version
            AND gba.attempt = NEW.attempt AND gba.status = 'BUILDING'
            AND gba.lease_id = NEW.lease_id AND gba.lease_expires_at = NEW.lease_expires_at
            AND gba.claimed_at = NEW.build_started_at AND gba.claimed_at = NEW.updated_at
            AND gba.storage_key = 'projects/' || NEW.project_id || '/graphs/v/' || NEW.version ||
              '/attempts/' || NEW.attempt || '/' || gba.publication_id || '/graph.json'
        )
      ) OR
      (
        OLD.status = 'BUILDING' AND NEW.status = 'FAILED' AND NEW.attempt = OLD.attempt AND
        EXISTS (
          SELECT 1 FROM graph_build_attempts gba
          WHERE gba.project_id = NEW.project_id AND gba.graph_version = NEW.version
            AND gba.attempt = NEW.attempt AND gba.status = 'FAILED'
            AND gba.lease_id = OLD.lease_id AND gba.lease_expires_at = OLD.lease_expires_at
            AND gba.claimed_at = OLD.build_started_at
            AND gba.failure_category = NEW.failure_category AND gba.failed_at = NEW.failed_at
            AND gba.failed_at = NEW.updated_at
            AND gba.storage_key = 'projects/' || NEW.project_id || '/graphs/v/' || NEW.version ||
              '/attempts/' || NEW.attempt || '/' || gba.publication_id || '/graph.json'
        )
      ) OR
      (
        OLD.status = 'BUILDING' AND NEW.status = 'READY' AND NEW.attempt = OLD.attempt AND
        EXISTS (
          SELECT 1 FROM graph_build_attempts gba
          WHERE gba.project_id = NEW.project_id AND gba.graph_version = NEW.version
            AND gba.attempt = NEW.attempt AND gba.status = 'PUBLISHED'
            AND gba.lease_id = OLD.lease_id AND gba.lease_expires_at = OLD.lease_expires_at
            AND gba.claimed_at = OLD.build_started_at
            AND gba.publication_id = NEW.selected_publication_id AND gba.storage_key = NEW.storage_key
            AND gba.checksum = NEW.checksum AND gba.byte_size = NEW.byte_size
            AND gba.content_type = 'application/json' AND gba.node_count = NEW.node_count
            AND gba.link_count = NEW.link_count AND gba.hyperedge_count = NEW.hyperedge_count
            AND gba.generated_by = NEW.generated_by AND gba.generated_by = gba.claimed_by
            AND gba.attempt = NEW.published_attempt AND gba.lease_id = NEW.published_lease_id
            AND gba.published_at = NEW.generated_at AND gba.published_at = NEW.updated_at
        )
      ) OR
      (
        OLD.status = 'READY' AND NEW.status = 'SUPERSEDED' AND NEW.attempt = OLD.attempt AND
        EXISTS (
          SELECT 1 FROM graph_build_attempts gba
          WHERE gba.project_id = OLD.project_id AND gba.graph_version = OLD.version
            AND gba.attempt = OLD.published_attempt AND gba.status = 'PUBLISHED'
            AND gba.publication_id = OLD.selected_publication_id AND gba.storage_key = OLD.storage_key
            AND gba.lease_id = OLD.published_lease_id AND gba.checksum = OLD.checksum
            AND gba.byte_size = OLD.byte_size AND gba.content_type = 'application/json'
            AND gba.node_count = OLD.node_count AND gba.link_count = OLD.link_count
            AND gba.hyperedge_count = OLD.hyperedge_count AND gba.generated_by = OLD.generated_by
            AND gba.generated_by = gba.claimed_by AND gba.published_at = OLD.generated_at
        )
      ) OR
      (
        OLD.status = 'FAILED' AND NEW.status = 'QUEUED' AND NEW.attempt = OLD.attempt + 1 AND
        (
          EXISTS (
            SELECT 1 FROM graph_build_attempts gba
            WHERE gba.project_id = OLD.project_id AND gba.graph_version = OLD.version
              AND gba.attempt = OLD.attempt AND gba.status = 'FAILED'
              AND gba.claimed_at = OLD.build_started_at
              AND gba.failure_category = OLD.failure_category AND gba.failed_at = OLD.failed_at
              AND gba.storage_key = 'projects/' || OLD.project_id || '/graphs/v/' || OLD.version ||
                '/attempts/' || OLD.attempt || '/' || gba.publication_id || '/graph.json'
          ) OR
          (
            OLD.failure_category = 'MIGRATION_RETRY' AND NOT EXISTS (
              SELECT 1 FROM graph_build_attempts gba
              WHERE gba.project_id = OLD.project_id AND gba.graph_version = OLD.version
                AND gba.attempt = OLD.attempt
            )
          )
        )
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'illegal graph transition');
END;


-- Publication must consume a lease that is current according to D1 itself;
-- caller-selected publication timestamps cannot extend or revive the lease.
DROP TRIGGER graph_attempt_publish_guard;
CREATE TRIGGER graph_attempt_publish_guard BEFORE UPDATE OF status ON graph_build_attempts
WHEN OLD.status='BUILDING' AND NEW.status='PUBLISHED'
BEGIN
  SELECT RAISE(ABORT,'stale graph publication') WHERE NOT EXISTS (
    SELECT 1 FROM graph_versions gv WHERE gv.project_id=NEW.project_id AND gv.version=NEW.graph_version
      AND gv.status='BUILDING' AND gv.attempt=NEW.attempt AND gv.lease_id=NEW.lease_id
      AND gv.lease_expires_at>NEW.published_at
      AND gv.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND NOT EXISTS (SELECT 1 FROM graph_versions newer WHERE newer.project_id=gv.project_id AND newer.status='READY' AND newer.version>gv.version)
  );
END;
