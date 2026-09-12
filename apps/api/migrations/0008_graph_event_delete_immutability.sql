PRAGMA foreign_keys = ON;

CREATE TRIGGER graph_events_immutable_delete
BEFORE DELETE ON graph_events
BEGIN
  SELECT RAISE(ABORT, 'graph event is immutable');
END;
