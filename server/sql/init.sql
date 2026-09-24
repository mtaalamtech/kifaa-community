-- ─────────────────────────────────────────────────────────────────────────────
-- Kifaa Platform — Database Schema
-- Auto-generated from live database. All tables use IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;


\restrict 6ZoYTeOfP5KKoJTuzGMEyWvFqAl3YhrqSGJosHJNugLUOi0p7EGeIby2p2H36rq
CREATE EXTENSION IF NOT EXISTS timescaledb WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;
CREATE TABLE public.metrics (
    "time" timestamp with time zone NOT NULL,
    agent_id uuid NOT NULL,
    metric_name character varying(100) NOT NULL,
    value double precision,
    tags jsonb DEFAULT '{}'::jsonb
);

CREATE VIEW _timescaledb_internal._direct_view_2 AS
 SELECT public.time_bucket('01:00:00'::interval, "time") AS bucket,
    agent_id,
    metric_name,
    avg(value) AS avg_value,
    max(value) AS max_value,
    min(value) AS min_value
   FROM public.metrics
  GROUP BY (public.time_bucket('01:00:00'::interval, "time")), agent_id, metric_name;

CREATE TABLE _timescaledb_internal._hyper_1_32_chunk (
    CONSTRAINT constraint_32 CHECK ((("time" >= '2026-07-23 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-07-30 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.metrics);

CREATE TABLE _timescaledb_internal._hyper_1_36_chunk (
    CONSTRAINT constraint_36 CHECK ((("time" >= '2026-07-30 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-08-06 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.metrics);

CREATE TABLE _timescaledb_internal._hyper_1_39_chunk (
    CONSTRAINT constraint_39 CHECK ((("time" >= '2026-08-06 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-08-13 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.metrics);

CREATE TABLE _timescaledb_internal._hyper_1_413_chunk (
    CONSTRAINT constraint_413 CHECK ((("time" >= '2026-08-20 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-08-27 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.metrics);

CREATE TABLE _timescaledb_internal._hyper_1_418_chunk (
    CONSTRAINT constraint_418 CHECK ((("time" >= '2026-08-27 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-09-03 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.metrics);

CREATE TABLE _timescaledb_internal._hyper_1_42_chunk (
    CONSTRAINT constraint_42 CHECK ((("time" >= '2026-08-13 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-08-20 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.metrics);

CREATE TABLE public.monitor_results (
    "time" timestamp with time zone NOT NULL,
    monitor_id uuid NOT NULL,
    status character varying(20),
    latency_ms integer,
    message text
);

CREATE TABLE _timescaledb_internal._hyper_7_11_chunk (
    CONSTRAINT constraint_11 CHECK ((("time" >= '2026-05-14 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-05-21 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_13_chunk (
    CONSTRAINT constraint_13 CHECK ((("time" >= '2026-05-21 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-05-28 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_15_chunk (
    CONSTRAINT constraint_15 CHECK ((("time" >= '2026-05-28 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-06-04 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_17_chunk (
    CONSTRAINT constraint_17 CHECK ((("time" >= '2026-06-04 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-06-11 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_19_chunk (
    CONSTRAINT constraint_19 CHECK ((("time" >= '2026-06-11 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-06-18 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_22_chunk (
    CONSTRAINT constraint_22 CHECK ((("time" >= '2026-06-18 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-06-25 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_24_chunk (
    CONSTRAINT constraint_24 CHECK ((("time" >= '2026-06-25 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-07-02 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_26_chunk (
    CONSTRAINT constraint_26 CHECK ((("time" >= '2026-07-02 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-07-09 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_28_chunk (
    CONSTRAINT constraint_28 CHECK ((("time" >= '2026-07-09 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-07-16 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_2_chunk (
    CONSTRAINT constraint_2 CHECK ((("time" >= '2026-04-09 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-04-16 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_31_chunk (
    CONSTRAINT constraint_31 CHECK ((("time" >= '2026-07-16 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-07-23 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_33_chunk (
    CONSTRAINT constraint_33 CHECK ((("time" >= '2026-07-23 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-07-30 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_35_chunk (
    CONSTRAINT constraint_35 CHECK ((("time" >= '2026-07-30 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-08-06 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_38_chunk (
    CONSTRAINT constraint_38 CHECK ((("time" >= '2026-08-06 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-08-13 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_3_chunk (
    CONSTRAINT constraint_3 CHECK ((("time" >= '2026-04-16 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-04-23 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_412_chunk (
    CONSTRAINT constraint_412 CHECK ((("time" >= '2026-08-13 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-08-20 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_415_chunk (
    CONSTRAINT constraint_415 CHECK ((("time" >= '2026-08-20 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-08-27 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_417_chunk (
    CONSTRAINT constraint_417 CHECK ((("time" >= '2026-08-27 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-09-03 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_5_chunk (
    CONSTRAINT constraint_5 CHECK ((("time" >= '2026-04-23 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-04-30 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_7_chunk (
    CONSTRAINT constraint_7 CHECK ((("time" >= '2026-04-30 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-05-07 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE _timescaledb_internal._hyper_7_9_chunk (
    CONSTRAINT constraint_9 CHECK ((("time" >= '2026-05-07 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-05-14 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.monitor_results);

CREATE TABLE public.siem_events (
    "time" timestamp with time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid,
    source_ip inet,
    log_source text DEFAULT 'unknown'::text NOT NULL,
    level text DEFAULT 'info'::text NOT NULL,
    event_id integer,
    channel text,
    message text DEFAULT ''::text NOT NULL,
    raw_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE _timescaledb_internal._hyper_8_21_chunk (
    CONSTRAINT constraint_21 CHECK ((("time" >= '2026-06-11 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-06-18 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.siem_events);

CREATE TABLE public.apc_ups_metrics (
    "time" timestamp with time zone DEFAULT now() NOT NULL,
    device_id uuid,
    battery_capacity_pct integer,
    battery_runtime_seconds integer,
    input_voltage_v integer,
    output_voltage_v integer,
    output_load_pct integer,
    output_current_a integer,
    status text
);

CREATE TABLE _timescaledb_internal._hyper_9_34_chunk (
    CONSTRAINT constraint_34 CHECK ((("time" >= '2026-07-23 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-07-30 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.apc_ups_metrics);

CREATE TABLE _timescaledb_internal._hyper_9_37_chunk (
    CONSTRAINT constraint_37 CHECK ((("time" >= '2026-07-30 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-08-06 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.apc_ups_metrics);

CREATE TABLE _timescaledb_internal._hyper_9_40_chunk (
    CONSTRAINT constraint_40 CHECK ((("time" >= '2026-08-06 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-08-13 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.apc_ups_metrics);

CREATE TABLE _timescaledb_internal._hyper_9_414_chunk (
    CONSTRAINT constraint_414 CHECK ((("time" >= '2026-08-20 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-08-27 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.apc_ups_metrics);

CREATE TABLE _timescaledb_internal._hyper_9_416_chunk (
    CONSTRAINT constraint_416 CHECK ((("time" >= '2026-08-27 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-09-03 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.apc_ups_metrics);

CREATE TABLE _timescaledb_internal._hyper_9_43_chunk (
    CONSTRAINT constraint_43 CHECK ((("time" >= '2026-08-13 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-08-20 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.apc_ups_metrics);

CREATE TABLE _timescaledb_internal._materialized_hypertable_2 (
    bucket timestamp with time zone NOT NULL,
    agent_id uuid,
    metric_name character varying(100),
    avg_value double precision,
    max_value double precision,
    min_value double precision
);

CREATE VIEW _timescaledb_internal._partial_view_2 AS
 SELECT public.time_bucket('01:00:00'::interval, "time") AS bucket,
    agent_id,
    metric_name,
    avg(value) AS avg_value,
    max(value) AS max_value,
    min(value) AS min_value
   FROM public.metrics
  GROUP BY (public.time_bucket('01:00:00'::interval, "time")), agent_id, metric_name;

CREATE TABLE public.ad_action_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid,
    performed_by uuid,
    performed_by_username character varying(100),
    action character varying(50) NOT NULL,
    target_user character varying(255) NOT NULL,
    notes text,
    status character varying(20) DEFAULT 'pending'::character varying,
    error_message text,
    created_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    action_id character varying(255),
    sam_account_name character varying(255)
);

CREATE TABLE public.ad_configs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid,
    domain_fqdn character varying(255) NOT NULL,
    dc_host character varying(255),
    base_dn text NOT NULL,
    service_account character varying(255),
    service_password text,
    max_pwd_age_days integer DEFAULT 90,
    sync_interval_seconds integer DEFAULT 900,
    is_active boolean DEFAULT true,
    last_sync_at timestamp with time zone,
    last_sync_status text,
    last_sync_error text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.ad_deleted_users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid,
    sam_account_name text NOT NULL,
    upn text,
    display_name text,
    email text,
    department text,
    title text,
    distinguished_name text,
    ou_path text,
    member_of jsonb DEFAULT '[]'::jsonb,
    is_admin boolean DEFAULT false,
    deleted_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_by text
);

CREATE TABLE public.ad_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid,
    event_id integer NOT NULL,
    event_time timestamp with time zone NOT NULL,
    target_user character varying(255),
    target_domain character varying(255),
    calling_computer character varying(255),
    calling_ip character varying(45),
    dc_name character varying(255),
    subject_user character varying(255),
    description text,
    raw_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.ad_groups (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid,
    sam_account_name character varying(255) NOT NULL,
    display_name character varying(255),
    description text,
    group_type character varying(50),
    group_scope character varying(50),
    member_count integer DEFAULT 0,
    members text[] DEFAULT '{}'::text[],
    ou_path text,
    is_privileged boolean DEFAULT false,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.ad_health_snapshots (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid,
    total_users integer DEFAULT 0,
    enabled_users integer DEFAULT 0,
    disabled_users integer DEFAULT 0,
    locked_users integer DEFAULT 0,
    stale_users_30d integer DEFAULT 0,
    stale_users_90d integer DEFAULT 0,
    expiring_passwords_7d integer DEFAULT 0,
    expired_passwords integer DEFAULT 0,
    never_expire_passwords integer DEFAULT 0,
    admin_count integer DEFAULT 0,
    service_account_count integer DEFAULT 0,
    total_groups integer DEFAULT 0,
    privileged_groups_count integer DEFAULT 0,
    compliance_score integer DEFAULT 0,
    score_breakdown jsonb DEFAULT '{}'::jsonb,
    snapped_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.ad_test_results (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    command_id uuid NOT NULL,
    agent_id uuid,
    success boolean,
    message text,
    latency_ms integer,
    tested_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.ad_users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid,
    sam_account_name character varying(255) NOT NULL,
    upn character varying(255),
    display_name character varying(255),
    email character varying(255),
    department character varying(255),
    title character varying(255),
    manager_dn text,
    ou_path text,
    distinguished_name text,
    account_enabled boolean DEFAULT true,
    locked_out boolean DEFAULT false,
    lockout_time timestamp with time zone,
    password_expired boolean DEFAULT false,
    password_never_expires boolean DEFAULT false,
    password_last_set timestamp with time zone,
    password_expires_at timestamp with time zone,
    last_logon timestamp with time zone,
    created_at_ad timestamp with time zone,
    member_of text[] DEFAULT '{}'::text[],
    is_admin boolean DEFAULT false,
    is_service_account boolean DEFAULT false,
    days_since_logon integer,
    user_account_control integer,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.agent_commands (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    command_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    picked_up_at timestamp with time zone
);

CREATE TABLE public.agent_groups (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    color character varying(7) DEFAULT '#3B82F6'::character varying,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.agent_high_risk_software (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    software_name text NOT NULL,
    software_version text,
    match_type text NOT NULL,
    severity text DEFAULT 'high'::text,
    detected_at timestamp with time zone DEFAULT now(),
    resolved_at timestamp with time zone
);

CREATE TABLE public.agent_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    event_type character varying(50) NOT NULL,
    field character varying(50),
    old_value text,
    new_value text,
    details jsonb DEFAULT '{}'::jsonb,
    triggered_by character varying(100) DEFAULT 'system'::character varying,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.agent_licenses (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid,
    software_name text,
    activation_status text,
    license_type text,
    partial_key text,
    expiry_date timestamp with time zone,
    license_channel text,
    updated_at timestamp with time zone DEFAULT now(),
    detected_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.agent_misconfigs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid,
    rule_id text,
    status text DEFAULT 'fail'::text,
    actual_value text,
    resolved_at timestamp with time zone,
    exception_id uuid,
    detected_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.agent_open_ports (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    port integer NOT NULL,
    protocol text DEFAULT 'tcp'::text,
    process_name text,
    process_pid integer,
    bind_address text,
    state text,
    first_seen timestamp with time zone DEFAULT now(),
    last_seen timestamp with time zone DEFAULT now()
);

CREATE TABLE public.agent_patches (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    package_name text NOT NULL,
    current_version text,
    available_version text,
    category text DEFAULT 'unknown'::text,
    description text,
    scanned_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.agent_security_state (
    agent_id uuid NOT NULL,
    av_installed boolean DEFAULT false,
    av_product text,
    av_running boolean DEFAULT false,
    av_last_scan text,
    firewall_enabled boolean DEFAULT false,
    firewall_product text,
    disk_encrypted boolean DEFAULT false,
    encryption_method text,
    auto_updates_enabled boolean DEFAULT false,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.agent_ssh_credentials (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    host_override text,
    port integer DEFAULT 22,
    username text NOT NULL,
    password text,
    ssh_key text,
    use_sudo boolean DEFAULT true,
    connect_type text DEFAULT 'linux'::text,
    winrm_port integer DEFAULT 5985,
    domain text,
    updated_at timestamp with time zone DEFAULT now(),
    rdp_ignore_cert boolean DEFAULT false,
    known_host_key text
);

CREATE TABLE public.agent_update_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    title text NOT NULL,
    kb text,
    installed_at timestamp with time zone,
    result text DEFAULT 'success'::text,
    category text DEFAULT 'update'::text,
    reported_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.agent_vulnerabilities (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid,
    cve_id text,
    software_name text,
    status text DEFAULT 'open'::text,
    severity text,
    software_version text,
    cvss_score numeric(4,1),
    detected_at timestamp with time zone DEFAULT now(),
    remediated_at timestamp with time zone,
    remediation_notes text
);

CREATE TABLE public.agent_watchdog_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    reachable boolean,
    action_taken character varying(50),
    success boolean,
    message text,
    triggered_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.agent_webconfig_findings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    server_type text NOT NULL,
    config_file text,
    finding_id text NOT NULL,
    severity text DEFAULT 'medium'::text,
    title text NOT NULL,
    detail text,
    remediation text,
    detected_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.agents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    hostname character varying(255) NOT NULL,
    display_name character varying(255),
    ip_address character varying(45),
    mac_address character varying(17),
    os_type character varying(50),
    os_name character varying(100),
    os_version character varying(100),
    os_arch character varying(20),
    agent_version character varying(20),
    agent_type character varying(20) DEFAULT 'modern'::character varying,
    status character varying(20) DEFAULT 'offline'::character varying,
    last_seen timestamp with time zone,
    registered_at timestamp with time zone DEFAULT now(),
    group_id uuid,
    tags jsonb DEFAULT '[]'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    api_key character varying(64) NOT NULL,
    api_key_expires_at timestamp with time zone,
    is_active boolean DEFAULT true,
    asset_type character varying(30),
    restart_pending boolean DEFAULT false,
    description text,
    exclude_from_reports boolean DEFAULT false NOT NULL,
    watchdog_enabled boolean DEFAULT true,
    is_restarting boolean DEFAULT false,
    restarting_job_id uuid
);

CREATE TABLE public.alert_rules (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    metric_name character varying(100),
    condition character varying(20),
    threshold numeric,
    duration_minutes integer DEFAULT 5,
    severity character varying(20) DEFAULT 'warning'::character varying,
    applies_to character varying(20) DEFAULT 'all'::character varying,
    group_id uuid,
    agent_id uuid,
    notification_channels jsonb DEFAULT '[]'::jsonb,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    rule_type character varying(50) DEFAULT 'metric'::character varying,
    notify_channels jsonb DEFAULT '[]'::jsonb
);

CREATE TABLE public.alerts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    rule_id uuid,
    agent_id uuid,
    severity character varying(20),
    message text,
    metric_value numeric,
    triggered_at timestamp with time zone DEFAULT now(),
    acknowledged_at timestamp with time zone,
    resolved_at timestamp with time zone,
    acknowledged_by uuid,
    status character varying(20) DEFAULT 'open'::character varying,
    source character varying(50) DEFAULT 'rule'::character varying
);

CREATE TABLE public.apc_ups_devices (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    host text NOT NULL,
    model text,
    serial_number text,
    firmware_version text,
    snmp_community text DEFAULT 'public'::text,
    snmp_version text DEFAULT '2c'::text,
    status text DEFAULT 'unknown'::text,
    battery_capacity_pct integer,
    battery_temp_c integer,
    battery_runtime_seconds integer,
    battery_status text,
    input_voltage_v integer,
    input_frequency_hz integer,
    output_voltage_v integer,
    output_frequency_hz integer,
    output_load_pct integer,
    output_current_a integer,
    alarm_flags text,
    last_polled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.audit_categories (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.audit_findings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    title text NOT NULL,
    observation text,
    source text DEFAULT 'internal'::text NOT NULL,
    area text DEFAULT 'other'::text,
    year integer NOT NULL,
    due_date date,
    status text DEFAULT 'pending'::text NOT NULL,
    reason text,
    risk_rating text DEFAULT 'medium'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    closed_at timestamp with time zone,
    risk_implication text,
    recommendation text,
    prev_management_comments text,
    current_management_comments text,
    rating_color text,
    individual_responsible text,
    implementation text
);

CREATE TABLE public.audit_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now(),
    user_id uuid,
    agent_id uuid,
    action character varying(100) NOT NULL,
    resource_type character varying(50),
    resource_id character varying(100),
    details jsonb DEFAULT '{}'::jsonb,
    ip_address character varying(45),
    result character varying(20) DEFAULT 'success'::character varying
);

CREATE TABLE public.backup_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    filename character varying(255),
    size_bytes bigint,
    status character varying(20) DEFAULT 'running'::character varying,
    trigger character varying(20),
    error text,
    started_at timestamp with time zone DEFAULT now(),
    finished_at timestamp with time zone
);

CREATE TABLE public.bot_audit_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    ts timestamp with time zone DEFAULT now(),
    platform text NOT NULL,
    platform_id text NOT NULL,
    display_name text,
    command text NOT NULL,
    parsed_command text,
    agent_id uuid,
    result text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE public.bot_users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    platform text NOT NULL,
    platform_id text NOT NULL,
    display_name text,
    hashed_pin text NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.compliance_snapshots (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    snapshot_date date DEFAULT CURRENT_DATE NOT NULL,
    category text NOT NULL,
    score numeric(5,1),
    details jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE public.consolidation_plans (
    id integer NOT NULL,
    agent_id uuid NOT NULL,
    server_role text,
    recommended_action character varying(50),
    confirmed_action character varying(50),
    destination_server_id uuid,
    utilization_notes text,
    dependency_notes text,
    has_dependencies boolean DEFAULT false,
    retention_months integer,
    retention_notes text,
    target_date date,
    rollback_plan text,
    confirmed_by character varying(100),
    status character varying(30) DEFAULT 'draft'::character varying,
    priority integer DEFAULT 3,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);

CREATE SEQUENCE public.consolidation_plans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.consolidation_plans_id_seq OWNED BY public.consolidation_plans.id;

CREATE TABLE public.cve_database (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    cve_id text NOT NULL,
    osv_id text,
    description text,
    severity text,
    cvss_score numeric(4,1),
    affected_products jsonb DEFAULT '[]'::jsonb,
    published_date timestamp with time zone,
    modified_date timestamp with time zone,
    "references" jsonb DEFAULT '[]'::jsonb,
    is_zero_day boolean DEFAULT false,
    remediation text,
    fetched_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.deploy_credentials (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    os_type character varying(20) DEFAULT 'any'::character varying,
    username character varying(100) NOT NULL,
    password text,
    ssh_key text,
    domain character varying(100),
    port integer,
    use_sudo boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone
);

CREATE TABLE public.deployment_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    target_host character varying(255) NOT NULL,
    target_port integer DEFAULT 22,
    os_type character varying(20) NOT NULL,
    username character varying(100),
    status character varying(20) DEFAULT 'pending'::character varying,
    logs text DEFAULT ''::text,
    agent_version character varying(50),
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    started_at timestamp with time zone,
    finished_at timestamp with time zone
);

CREATE TABLE public.disk_volume_settings (
    agent_id uuid NOT NULL,
    mountpoint text NOT NULL,
    exclude_from_reports boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.events (
    "time" timestamp with time zone NOT NULL,
    agent_id uuid,
    event_type character varying(50),
    source character varying(100),
    severity character varying(20),
    message text,
    raw_data jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE public.hardware_inventory (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    cpu_model character varying(255),
    cpu_cores integer,
    cpu_threads integer,
    ram_total_gb numeric(10,2),
    disks jsonb DEFAULT '[]'::jsonb,
    nics jsonb DEFAULT '[]'::jsonb,
    gpu jsonb DEFAULT '[]'::jsonb,
    bios_vendor character varying(100),
    bios_version character varying(100),
    bios_date character varying(50),
    motherboard_vendor character varying(100),
    motherboard_model character varying(100),
    serial_number character varying(100),
    asset_tag character varying(100),
    last_updated timestamp with time zone DEFAULT now(),
    dns_servers jsonb DEFAULT '[]'::jsonb,
    default_gateway character varying(64)
);

CREATE TABLE public.high_risk_rules (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    match_type text NOT NULL,
    match_pattern text NOT NULL,
    severity text DEFAULT 'high'::text,
    description text,
    is_active boolean DEFAULT true
);

CREATE TABLE public.integration_plugins (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    plugin_type text NOT NULL,
    display_name text NOT NULL,
    description text,
    icon text DEFAULT 'plug'::text,
    is_enabled boolean DEFAULT false,
    config jsonb DEFAULT '{}'::jsonb,
    credentials jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'disconnected'::text,
    last_sync_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.integration_sync_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    plugin_type text NOT NULL,
    started_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    status text DEFAULT 'running'::text,
    records_synced integer DEFAULT 0,
    error_message text
);

CREATE TABLE public.maintenance_cycle_agents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    cycle_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.maintenance_cycles (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text,
    frequency text DEFAULT 'monthly'::text,
    patch_day text DEFAULT 'Monday'::text,
    patch_week text DEFAULT '1st'::text,
    preferred_time text DEFAULT '02:00'::text,
    restart_action text DEFAULT 'none'::text,
    pre_notification_hours integer DEFAULT 24,
    notes text DEFAULT ''::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    cycle_type text DEFAULT 'patch'::text,
    group_name text DEFAULT ''::text,
    linked_cycle_id uuid,
    maint_frequency text DEFAULT 'monthly'::text,
    maint_day text DEFAULT 'Wednesday'::text,
    maint_week text DEFAULT '1st'::text,
    maint_time text DEFAULT '22:00'::text,
    maint_restart_action text DEFAULT 'none'::text
);

CREATE TABLE public.maintenance_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    cycle_id uuid,
    agent_id uuid NOT NULL,
    actioned_at timestamp with time zone DEFAULT now() NOT NULL,
    action_type text DEFAULT 'patch'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    notes text DEFAULT ''::text,
    created_by text DEFAULT ''::text,
    created_at timestamp with time zone DEFAULT now(),
    patch_job_id uuid
);

CREATE TABLE public.maintenance_notification_settings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text DEFAULT ''::text,
    email text NOT NULL,
    notification_type text DEFAULT 'post_patch'::text NOT NULL,
    cycle_type_filter text DEFAULT 'all'::text NOT NULL,
    send_time text DEFAULT '09:00'::text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.maintenance_reports (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    cycle_id uuid,
    report_type text DEFAULT 'post_patch'::text NOT NULL,
    group_name text DEFAULT ''::text,
    period_start date,
    period_end date,
    patches_applied integer DEFAULT 0,
    patches_failed integer DEFAULT 0,
    servers_affected integer DEFAULT 0,
    services_verified boolean DEFAULT true,
    issues_found text DEFAULT ''::text,
    actions_taken text DEFAULT ''::text,
    rollback_required boolean DEFAULT false,
    next_steps text DEFAULT ''::text,
    status text DEFAULT 'completed'::text,
    created_by text DEFAULT ''::text,
    created_at timestamp with time zone DEFAULT now()
);

CREATE VIEW public.metrics_hourly AS
 SELECT bucket,
    agent_id,
    metric_name,
    avg_value,
    max_value,
    min_value
   FROM _timescaledb_internal._materialized_hypertable_2;

CREATE TABLE public.misconfig_rules (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    rule_id text NOT NULL,
    category text NOT NULL,
    platform text DEFAULT 'all'::text,
    title text NOT NULL,
    description text,
    severity text DEFAULT 'medium'::text,
    check_field text NOT NULL,
    expected_value text NOT NULL,
    remediation text,
    is_active boolean DEFAULT true
);

CREATE TABLE public.monitored_ports (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(255) NOT NULL,
    host character varying(255) NOT NULL,
    port integer NOT NULL,
    protocol character varying(10) DEFAULT 'tcp'::character varying,
    check_interval_seconds integer DEFAULT 60,
    timeout_seconds integer DEFAULT 5,
    is_active boolean DEFAULT true,
    last_status character varying(20) DEFAULT 'unknown'::character varying,
    last_checked timestamp with time zone,
    last_latency_ms integer,
    consecutive_failures integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.monitors (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(255) NOT NULL,
    monitor_type character varying(50) NOT NULL,
    category character varying(50) DEFAULT 'network'::character varying NOT NULL,
    subtype character varying(100),
    host character varying(255),
    port integer,
    config jsonb DEFAULT '{}'::jsonb,
    check_interval_seconds integer DEFAULT 60,
    timeout_seconds integer DEFAULT 10,
    is_active boolean DEFAULT true,
    last_status character varying(20) DEFAULT 'unknown'::character varying,
    last_checked timestamp with time zone,
    last_latency_ms integer,
    last_message text,
    consecutive_failures integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    group_id uuid,
    agent_id uuid
);

CREATE TABLE public.notification_channels (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    type character varying(30) NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.nutanix_alerts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    alert_id text,
    severity text,
    title text,
    message text,
    entity_type text,
    created_at timestamp with time zone,
    resolved boolean DEFAULT false,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.nutanix_clusters (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    cluster_id text,
    name text,
    cluster_uuid text,
    num_nodes integer DEFAULT 0,
    version text,
    hypervisor text,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.nutanix_hosts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    host_id text,
    name text,
    ip_address text,
    hypervisor_type text,
    num_cpus integer DEFAULT 0,
    cpu_capacity_hz bigint DEFAULT 0,
    memory_capacity_mb bigint DEFAULT 0,
    cluster_name text,
    num_vms integer DEFAULT 0,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.nutanix_vms (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    vm_id text,
    name text,
    power_state text,
    num_vcpus integer DEFAULT 0,
    memory_mb integer DEFAULT 0,
    host_name text,
    cluster_name text,
    guest_os text,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.o365_licenses (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    sku_id text,
    sku_name text,
    total_units integer,
    consumed_units integer,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.o365_users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id text,
    display_name text,
    email text,
    account_enabled boolean,
    last_sign_in timestamp with time zone,
    assigned_licenses jsonb DEFAULT '[]'::jsonb,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.patch_jobs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    job_type text DEFAULT 'scan'::text NOT NULL,
    packages text[] DEFAULT '{}'::text[],
    status text DEFAULT 'pending'::text,
    output text DEFAULT ''::text,
    triggered_by text DEFAULT 'manual'::text,
    started_at timestamp with time zone DEFAULT now(),
    finished_at timestamp with time zone,
    reboot_after boolean DEFAULT false NOT NULL,
    reboot_mode text DEFAULT 'silent'::text NOT NULL,
    reboot_delay_seconds integer DEFAULT 60 NOT NULL,
    schedule_run_id uuid
);

CREATE TABLE public.patch_schedule_runs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    schedule_id uuid NOT NULL,
    schedule_name text,
    fired_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    status text DEFAULT 'running'::text,
    agents_targeted integer DEFAULT 0,
    agents_queued integer DEFAULT 0,
    total_jobs integer DEFAULT 0,
    success_count integer DEFAULT 0,
    failed_count integer DEFAULT 0,
    pending_count integer DEFAULT 0
);

CREATE TABLE public.patch_schedules (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    description text,
    target_type text DEFAULT 'all'::text NOT NULL,
    agent_id uuid,
    group_id uuid,
    os_filter text DEFAULT 'all'::text,
    categories jsonb DEFAULT '["security"]'::jsonb,
    frequency text DEFAULT 'weekly'::text NOT NULL,
    scheduled_at timestamp with time zone,
    day_of_week integer,
    day_of_month integer,
    hour_utc integer DEFAULT 2 NOT NULL,
    minute_utc integer DEFAULT 0 NOT NULL,
    reboot_after boolean DEFAULT false,
    reboot_mode text DEFAULT 'silent'::text,
    reboot_delay_seconds integer DEFAULT 60,
    is_active boolean DEFAULT true,
    last_run timestamp with time zone,
    next_run timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.pending_patches (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid,
    category text,
    package_name text,
    severity text
);

CREATE TABLE public.phishing_campaigns (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'draft'::text,
    template_id uuid,
    smtp_channel_id uuid,
    base_url text DEFAULT ''::text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_by text,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.phishing_targets (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    campaign_id uuid NOT NULL,
    email text NOT NULL,
    first_name text DEFAULT ''::text,
    last_name text DEFAULT ''::text,
    department text DEFAULT ''::text,
    token text DEFAULT (gen_random_uuid())::text NOT NULL,
    send_status text DEFAULT 'pending'::text,
    sent_at timestamp with time zone,
    opened_at timestamp with time zone,
    clicked_at timestamp with time zone,
    submitted_at timestamp with time zone,
    reported_at timestamp with time zone,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.phishing_templates (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    category text DEFAULT 'credential'::text,
    subject text NOT NULL,
    sender_name text DEFAULT 'IT Support'::text,
    sender_email text DEFAULT 'support@company.com'::text,
    body_html text NOT NULL,
    landing_page_html text DEFAULT ''::text,
    is_builtin boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.port_check_results (
    "time" timestamp with time zone DEFAULT now() NOT NULL,
    port_id uuid NOT NULL,
    status character varying(20) NOT NULL,
    latency_ms integer
);

CREATE TABLE public.proxmox_nodes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    node_id text,
    name text,
    status text,
    cpu_usage numeric(8,4) DEFAULT 0,
    maxcpu integer DEFAULT 0,
    mem bigint DEFAULT 0,
    maxmem bigint DEFAULT 0,
    disk bigint DEFAULT 0,
    maxdisk bigint DEFAULT 0,
    uptime_seconds bigint DEFAULT 0,
    pve_version text,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.proxmox_storage (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    stor_id text,
    name text,
    node_name text,
    storage_type text,
    total_bytes bigint DEFAULT 0,
    used_bytes bigint DEFAULT 0,
    avail_bytes bigint DEFAULT 0,
    enabled boolean DEFAULT true,
    shared boolean DEFAULT false,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.proxmox_vms (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    vm_id text,
    vmid integer,
    name text,
    type text,
    status text,
    node_name text,
    cpu_usage numeric(8,4) DEFAULT 0,
    cpus integer DEFAULT 0,
    mem bigint DEFAULT 0,
    maxmem bigint DEFAULT 0,
    disk bigint DEFAULT 0,
    maxdisk bigint DEFAULT 0,
    uptime_seconds bigint DEFAULT 0,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.quarterly_sla_config (
    severity text NOT NULL,
    contain_hours integer DEFAULT 24 NOT NULL,
    resolve_hours integer DEFAULT 72 NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.quarterly_snapshots (
    quarter integer NOT NULL,
    year integer NOT NULL,
    patch_total integer,
    patch_compliant integer,
    patch_pct numeric(5,1),
    ep_total integer,
    ep_av_pass integer,
    ep_av_pct numeric(5,1),
    ep_threat_free integer,
    ep_threat_pct numeric(5,1),
    snapshot_at timestamp with time zone DEFAULT now() NOT NULL,
    snapshot_by text
);

CREATE TABLE public.rdp_sessions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    username character varying(128) NOT NULL,
    domain character varying(128) DEFAULT ''::character varying,
    source_ip character varying(45) DEFAULT ''::character varying,
    session_id integer DEFAULT 0,
    logon_time timestamp with time zone NOT NULL,
    logoff_time timestamp with time zone,
    duration_seconds integer,
    logoff_type character varying(20) DEFAULT 'unknown'::character varying,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.reboot_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    target_type character varying(20) NOT NULL,
    agent_id uuid,
    group_id uuid,
    frequency character varying(20) NOT NULL,
    day_of_week smallint,
    day_of_month smallint,
    hour_utc smallint DEFAULT 2 NOT NULL,
    minute_utc smallint DEFAULT 0 NOT NULL,
    mode character varying(20) DEFAULT 'announced'::character varying NOT NULL,
    delay_seconds integer DEFAULT 60 NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    last_run_at timestamp with time zone,
    next_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.sap_employees (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    employee_id integer,
    first_name text,
    last_name text,
    email text,
    department_id integer,
    department_name text,
    job_title text,
    active boolean DEFAULT true,
    start_date date,
    termination_date date,
    mobile_phone text,
    office_phone text,
    sap_user_code text,
    sap_internal_key integer,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.sap_users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    internal_key integer,
    user_code text,
    user_name text,
    email text,
    locked boolean DEFAULT false,
    superuser boolean DEFAULT false,
    group_name text,
    last_logout_date date,
    department_id integer,
    department_name text,
    employee_id integer,
    employee_first_name text,
    employee_last_name text,
    active boolean DEFAULT true,
    job_title text,
    mobile_phone text,
    license_type text DEFAULT 'unknown'::text,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.scheduled_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    report_type character varying(50) NOT NULL,
    format character varying(10) DEFAULT 'pdf'::character varying,
    frequency character varying(20) DEFAULT 'daily'::character varying,
    hour integer DEFAULT 8,
    minute integer DEFAULT 0,
    day_of_week integer,
    day_of_month integer,
    email_to jsonb DEFAULT '[]'::jsonb,
    channel_ids jsonb DEFAULT '[]'::jsonb,
    status_filter character varying(50) DEFAULT 'all'::character varying,
    is_active boolean DEFAULT true,
    last_run timestamp with time zone,
    next_run timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.scheduled_tasks (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(255) NOT NULL,
    task_type character varying(50) NOT NULL,
    agent_id uuid,
    group_id uuid,
    schedule_type character varying(20) NOT NULL,
    scheduled_at timestamp with time zone,
    cron_expression character varying(100),
    payload jsonb DEFAULT '{}'::jsonb,
    status character varying(30) DEFAULT 'pending'::character varying,
    last_run timestamp with time zone,
    next_run timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.security_incidents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    title text NOT NULL,
    description text,
    severity text DEFAULT 'medium'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    contained_at timestamp with time zone,
    resolved_at timestamp with time zone,
    reporter text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.service_monitor_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    service_name character varying(255) NOT NULL,
    display_name character varying(255),
    event_type character varying(50) NOT NULL,
    old_status character varying(50),
    triggered_at timestamp with time zone DEFAULT now(),
    success boolean,
    message text
);

CREATE TABLE public.service_status_log (
    "time" timestamp with time zone NOT NULL,
    agent_id uuid NOT NULL,
    service_name character varying(255) NOT NULL,
    status character varying(50),
    pid integer,
    cpu_percent double precision,
    memory_mb double precision
);

CREATE TABLE public.services (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    service_name character varying(255) NOT NULL,
    display_name character varying(255),
    status character varying(50),
    startup_type character varying(50),
    pid integer,
    description text,
    exe_path text,
    last_start_time timestamp with time zone,
    last_start_duration_ms integer,
    monitored boolean DEFAULT false,
    last_updated timestamp with time zone DEFAULT now(),
    auto_restart boolean DEFAULT false
);

CREATE TABLE public.software_deploy_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    package_id uuid,
    agent_id uuid,
    status text DEFAULT 'pending'::text,
    output text DEFAULT ''::text,
    error_message text,
    triggered_by uuid,
    triggered_by_username text,
    queued_at timestamp with time zone DEFAULT now(),
    started_at timestamp with time zone,
    finished_at timestamp with time zone
);

CREATE TABLE public.software_inventory (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    version character varying(100),
    publisher character varying(255),
    install_date character varying(20),
    install_location text,
    uninstall_key text,
    size_mb numeric(10,2),
    first_seen timestamp with time zone DEFAULT now(),
    last_seen timestamp with time zone DEFAULT now()
);

CREATE TABLE public.software_packages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    version text,
    description text,
    file_path text,
    download_url text,
    checksum_sha256 text,
    installer_type text DEFAULT 'exe'::text,
    install_args text DEFAULT ''::text,
    os_type text DEFAULT 'windows'::text,
    size_bytes bigint,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.software_uninstall_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_id uuid,
    software_name text NOT NULL,
    software_version text DEFAULT ''::text,
    status text DEFAULT 'pending'::text,
    output text DEFAULT ''::text,
    error_message text,
    triggered_by uuid,
    triggered_by_username text,
    queued_at timestamp with time zone DEFAULT now(),
    finished_at timestamp with time zone
);

CREATE TABLE public.sophos_alerts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    alert_id text,
    severity text,
    category text,
    description text,
    endpoint_hostname text,
    raised_at timestamp with time zone,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.sophos_endpoints (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    endpoint_id text,
    hostname text,
    health_status text,
    os_name text,
    ip_address text,
    last_seen timestamp with time zone,
    tamper_protection boolean DEFAULT false,
    group_name text,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.sophos_licenses (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    license_id text,
    product_name text,
    license_type text,
    starts_at timestamp with time zone,
    expires_at timestamp with time zone,
    quantity integer DEFAULT 0,
    used_quantity integer DEFAULT 0,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.ssl_certificates (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(255) NOT NULL,
    common_name character varying(255),
    san_names jsonb DEFAULT '[]'::jsonb,
    organization character varying(255),
    org_unit character varying(255),
    country character varying(2),
    state character varying(100),
    city character varying(100),
    email character varying(255),
    key_type character varying(20) DEFAULT 'RSA'::character varying,
    key_size integer DEFAULT 2048,
    csr_path text,
    cert_path text,
    key_path text,
    issued_by character varying(255),
    valid_from timestamp with time zone,
    valid_until timestamp with time zone,
    status character varying(30) DEFAULT 'csr_pending'::character varying,
    used_for character varying(50) DEFAULT 'platform'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    created_by uuid,
    renewed_from_id uuid,
    provider character varying(30) DEFAULT 'manual'::character varying,
    auto_renew boolean DEFAULT false,
    le_email text,
    le_staging boolean DEFAULT false
);

CREATE TABLE public.system_settings (
    key character varying(100) NOT NULL,
    value jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by uuid
);

CREATE TABLE public.threat_exceptions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    exception_type text NOT NULL,
    match_value text NOT NULL,
    agent_id uuid,
    reason text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone,
    is_active boolean DEFAULT true
);

CREATE TABLE public.unitrends_alerts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    alert_id text,
    severity text,
    message text,
    alert_time timestamp with time zone,
    acknowledged boolean DEFAULT false,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.unitrends_backups (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    backup_id text,
    client_name text,
    instance_name text,
    backup_type text,
    status text,
    start_time timestamp with time zone,
    end_time timestamp with time zone,
    size_bytes bigint,
    message text,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.unitrends_clients (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    client_id text,
    client_name text,
    os text,
    ip_address text,
    status text,
    last_backup timestamp with time zone,
    total_backups integer DEFAULT 0,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.unitrends_storage (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    device_name text,
    total_bytes bigint,
    used_bytes bigint,
    free_bytes bigint,
    usage_pct numeric(5,1),
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.ups_shutdown_event_agents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    event_id uuid,
    agent_id uuid,
    hostname text,
    os_type text,
    shutdown_order integer,
    status text DEFAULT 'pending'::text,
    sent_at timestamp with time zone,
    error text
);

CREATE TABLE public.ups_shutdown_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    policy_id uuid,
    device_id uuid,
    device_name text,
    policy_name text,
    triggered_at timestamp with time zone DEFAULT now(),
    trigger_reason text,
    cancel_deadline timestamp with time zone,
    status text DEFAULT 'pending'::text,
    cancelled_at timestamp with time zone,
    cancelled_by text,
    completed_at timestamp with time zone,
    agents_total integer DEFAULT 0,
    agents_shutdown integer DEFAULT 0
);

CREATE TABLE public.ups_shutdown_policies (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    device_id uuid,
    is_active boolean DEFAULT true,
    trigger_runtime_seconds integer DEFAULT 600,
    trigger_battery_pct integer DEFAULT 20,
    trigger_mode text DEFAULT 'any'::text,
    cancel_window_seconds integer DEFAULT 120,
    delay_between_agents_seconds integer DEFAULT 30,
    notify_bot boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.ups_shutdown_policy_agents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    policy_id uuid,
    agent_id uuid,
    shutdown_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.uptime_checks (
    "time" timestamp with time zone NOT NULL,
    agent_id uuid NOT NULL,
    check_type character varying(30),
    target character varying(255),
    status character varying(20),
    latency_ms integer,
    details jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    username character varying(100) NOT NULL,
    email character varying(255) NOT NULL,
    full_name character varying(255),
    hashed_password text NOT NULL,
    role character varying(50) DEFAULT 'viewer'::character varying,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    last_login timestamp with time zone,
    password_must_change boolean DEFAULT false
);

CREATE TABLE public.vmware_clusters (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    cluster_id text,
    name text,
    ha_enabled boolean DEFAULT false,
    drs_enabled boolean DEFAULT false,
    host_count integer DEFAULT 0,
    vm_count integer DEFAULT 0,
    cpu_cores integer,
    memory_mb bigint,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.vmware_datastores (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    ds_id text,
    name text,
    ds_type text,
    capacity_mb bigint,
    free_mb bigint,
    accessible boolean DEFAULT true,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.vmware_hosts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    host_id text,
    name text,
    connection_state text,
    power_state text,
    cpu_cores integer,
    cpu_threads integer,
    cpu_mhz integer,
    cpu_usage_mhz integer,
    memory_mb bigint,
    memory_usage_mb bigint,
    vm_count integer DEFAULT 0,
    cluster_name text,
    version text,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.vmware_vms (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    vm_id text,
    name text,
    power_state text,
    cpu_count integer,
    memory_mb integer,
    guest_os text,
    ip_address text,
    host_name text,
    cluster_name text,
    datastore_name text,
    cpu_usage_mhz integer,
    memory_usage_mb integer,
    tools_status text,
    tools_version text,
    synced_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    vcenter_created_at timestamp with time zone
);

ALTER TABLE ONLY _timescaledb_internal._hyper_1_32_chunk ALTER COLUMN tags SET DEFAULT '{}'::jsonb;

ALTER TABLE ONLY _timescaledb_internal._hyper_1_36_chunk ALTER COLUMN tags SET DEFAULT '{}'::jsonb;

ALTER TABLE ONLY _timescaledb_internal._hyper_1_39_chunk ALTER COLUMN tags SET DEFAULT '{}'::jsonb;

ALTER TABLE ONLY _timescaledb_internal._hyper_1_413_chunk ALTER COLUMN tags SET DEFAULT '{}'::jsonb;

ALTER TABLE ONLY _timescaledb_internal._hyper_1_418_chunk ALTER COLUMN tags SET DEFAULT '{}'::jsonb;

ALTER TABLE ONLY _timescaledb_internal._hyper_1_42_chunk ALTER COLUMN tags SET DEFAULT '{}'::jsonb;

ALTER TABLE ONLY _timescaledb_internal._hyper_8_21_chunk ALTER COLUMN "time" SET DEFAULT now();

ALTER TABLE ONLY _timescaledb_internal._hyper_8_21_chunk ALTER COLUMN id SET DEFAULT public.uuid_generate_v4();

ALTER TABLE ONLY _timescaledb_internal._hyper_8_21_chunk ALTER COLUMN log_source SET DEFAULT 'unknown'::text;

ALTER TABLE ONLY _timescaledb_internal._hyper_8_21_chunk ALTER COLUMN level SET DEFAULT 'info'::text;

ALTER TABLE ONLY _timescaledb_internal._hyper_8_21_chunk ALTER COLUMN message SET DEFAULT ''::text;

ALTER TABLE ONLY _timescaledb_internal._hyper_8_21_chunk ALTER COLUMN raw_data SET DEFAULT '{}'::jsonb;

ALTER TABLE ONLY _timescaledb_internal._hyper_8_21_chunk ALTER COLUMN ingested_at SET DEFAULT now();

ALTER TABLE ONLY _timescaledb_internal._hyper_9_34_chunk ALTER COLUMN "time" SET DEFAULT now();

ALTER TABLE ONLY _timescaledb_internal._hyper_9_37_chunk ALTER COLUMN "time" SET DEFAULT now();

ALTER TABLE ONLY _timescaledb_internal._hyper_9_40_chunk ALTER COLUMN "time" SET DEFAULT now();

ALTER TABLE ONLY _timescaledb_internal._hyper_9_414_chunk ALTER COLUMN "time" SET DEFAULT now();

ALTER TABLE ONLY _timescaledb_internal._hyper_9_416_chunk ALTER COLUMN "time" SET DEFAULT now();

ALTER TABLE ONLY _timescaledb_internal._hyper_9_43_chunk ALTER COLUMN "time" SET DEFAULT now();

ALTER TABLE ONLY public.consolidation_plans ALTER COLUMN id SET DEFAULT nextval('public.consolidation_plans_id_seq'::regclass);

ALTER TABLE ONLY public.ad_action_log
    ADD CONSTRAINT ad_action_log_action_id_key UNIQUE (action_id);

ALTER TABLE ONLY public.ad_action_log
    ADD CONSTRAINT ad_action_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ad_configs
    ADD CONSTRAINT ad_configs_agent_id_key UNIQUE (agent_id);

ALTER TABLE ONLY public.ad_configs
    ADD CONSTRAINT ad_configs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ad_deleted_users
    ADD CONSTRAINT ad_deleted_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ad_events
    ADD CONSTRAINT ad_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ad_groups
    ADD CONSTRAINT ad_groups_agent_id_sam_account_name_key UNIQUE (agent_id, sam_account_name);

ALTER TABLE ONLY public.ad_groups
    ADD CONSTRAINT ad_groups_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ad_health_snapshots
    ADD CONSTRAINT ad_health_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ad_test_results
    ADD CONSTRAINT ad_test_results_command_id_key UNIQUE (command_id);

ALTER TABLE ONLY public.ad_test_results
    ADD CONSTRAINT ad_test_results_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ad_users
    ADD CONSTRAINT ad_users_agent_id_sam_account_name_key UNIQUE (agent_id, sam_account_name);

ALTER TABLE ONLY public.ad_users
    ADD CONSTRAINT ad_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_commands
    ADD CONSTRAINT agent_commands_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_groups
    ADD CONSTRAINT agent_groups_name_key UNIQUE (name);

ALTER TABLE ONLY public.agent_groups
    ADD CONSTRAINT agent_groups_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_high_risk_software
    ADD CONSTRAINT agent_high_risk_software_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_history
    ADD CONSTRAINT agent_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_licenses
    ADD CONSTRAINT agent_licenses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_misconfigs
    ADD CONSTRAINT agent_misconfigs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_open_ports
    ADD CONSTRAINT agent_open_ports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_patches
    ADD CONSTRAINT agent_patches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_security_state
    ADD CONSTRAINT agent_security_state_pkey PRIMARY KEY (agent_id);

ALTER TABLE ONLY public.agent_ssh_credentials
    ADD CONSTRAINT agent_ssh_credentials_agent_id_key UNIQUE (agent_id);

ALTER TABLE ONLY public.agent_ssh_credentials
    ADD CONSTRAINT agent_ssh_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_update_history
    ADD CONSTRAINT agent_update_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_vulnerabilities
    ADD CONSTRAINT agent_vulnerabilities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_watchdog_events
    ADD CONSTRAINT agent_watchdog_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_webconfig_findings
    ADD CONSTRAINT agent_webconfig_findings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_api_key_key UNIQUE (api_key);

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.alert_rules
    ADD CONSTRAINT alert_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.apc_ups_devices
    ADD CONSTRAINT apc_ups_devices_host_key UNIQUE (host);

ALTER TABLE ONLY public.apc_ups_devices
    ADD CONSTRAINT apc_ups_devices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.audit_categories
    ADD CONSTRAINT audit_categories_name_key UNIQUE (name);

ALTER TABLE ONLY public.audit_categories
    ADD CONSTRAINT audit_categories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.audit_findings
    ADD CONSTRAINT audit_findings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.backup_history
    ADD CONSTRAINT backup_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.bot_audit_log
    ADD CONSTRAINT bot_audit_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.bot_users
    ADD CONSTRAINT bot_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.bot_users
    ADD CONSTRAINT bot_users_platform_platform_id_key UNIQUE (platform, platform_id);

ALTER TABLE ONLY public.compliance_snapshots
    ADD CONSTRAINT compliance_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.compliance_snapshots
    ADD CONSTRAINT compliance_snapshots_snapshot_date_category_key UNIQUE (snapshot_date, category);

ALTER TABLE ONLY public.consolidation_plans
    ADD CONSTRAINT consolidation_plans_agent_id_key UNIQUE (agent_id);

ALTER TABLE ONLY public.consolidation_plans
    ADD CONSTRAINT consolidation_plans_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cve_database
    ADD CONSTRAINT cve_database_cve_id_key UNIQUE (cve_id);

ALTER TABLE ONLY public.cve_database
    ADD CONSTRAINT cve_database_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deploy_credentials
    ADD CONSTRAINT deploy_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deployment_jobs
    ADD CONSTRAINT deployment_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.disk_volume_settings
    ADD CONSTRAINT disk_volume_settings_pkey PRIMARY KEY (agent_id, mountpoint);

ALTER TABLE ONLY public.hardware_inventory
    ADD CONSTRAINT hardware_inventory_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.high_risk_rules
    ADD CONSTRAINT high_risk_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.integration_plugins
    ADD CONSTRAINT integration_plugins_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.integration_plugins
    ADD CONSTRAINT integration_plugins_plugin_type_key UNIQUE (plugin_type);

ALTER TABLE ONLY public.integration_sync_log
    ADD CONSTRAINT integration_sync_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.maintenance_cycle_agents
    ADD CONSTRAINT maintenance_cycle_agents_cycle_id_agent_id_key UNIQUE (cycle_id, agent_id);

ALTER TABLE ONLY public.maintenance_cycle_agents
    ADD CONSTRAINT maintenance_cycle_agents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.maintenance_cycles
    ADD CONSTRAINT maintenance_cycles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.maintenance_history
    ADD CONSTRAINT maintenance_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.maintenance_notification_settings
    ADD CONSTRAINT maintenance_notification_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.maintenance_reports
    ADD CONSTRAINT maintenance_reports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.misconfig_rules
    ADD CONSTRAINT misconfig_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.misconfig_rules
    ADD CONSTRAINT misconfig_rules_rule_id_key UNIQUE (rule_id);

ALTER TABLE ONLY public.monitored_ports
    ADD CONSTRAINT monitored_ports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.monitors
    ADD CONSTRAINT monitors_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.nutanix_alerts
    ADD CONSTRAINT nutanix_alerts_alert_id_key UNIQUE (alert_id);

ALTER TABLE ONLY public.nutanix_alerts
    ADD CONSTRAINT nutanix_alerts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.nutanix_clusters
    ADD CONSTRAINT nutanix_clusters_cluster_id_key UNIQUE (cluster_id);

ALTER TABLE ONLY public.nutanix_clusters
    ADD CONSTRAINT nutanix_clusters_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.nutanix_hosts
    ADD CONSTRAINT nutanix_hosts_host_id_key UNIQUE (host_id);

ALTER TABLE ONLY public.nutanix_hosts
    ADD CONSTRAINT nutanix_hosts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.nutanix_vms
    ADD CONSTRAINT nutanix_vms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.nutanix_vms
    ADD CONSTRAINT nutanix_vms_vm_id_key UNIQUE (vm_id);

ALTER TABLE ONLY public.o365_licenses
    ADD CONSTRAINT o365_licenses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.o365_licenses
    ADD CONSTRAINT o365_licenses_sku_id_key UNIQUE (sku_id);

ALTER TABLE ONLY public.o365_users
    ADD CONSTRAINT o365_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.o365_users
    ADD CONSTRAINT o365_users_user_id_key UNIQUE (user_id);

ALTER TABLE ONLY public.patch_jobs
    ADD CONSTRAINT patch_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patch_schedule_runs
    ADD CONSTRAINT patch_schedule_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patch_schedules
    ADD CONSTRAINT patch_schedules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pending_patches
    ADD CONSTRAINT pending_patches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.phishing_campaigns
    ADD CONSTRAINT phishing_campaigns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.phishing_targets
    ADD CONSTRAINT phishing_targets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.phishing_targets
    ADD CONSTRAINT phishing_targets_token_key UNIQUE (token);

ALTER TABLE ONLY public.phishing_templates
    ADD CONSTRAINT phishing_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.proxmox_nodes
    ADD CONSTRAINT proxmox_nodes_node_id_key UNIQUE (node_id);

ALTER TABLE ONLY public.proxmox_nodes
    ADD CONSTRAINT proxmox_nodes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.proxmox_storage
    ADD CONSTRAINT proxmox_storage_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.proxmox_storage
    ADD CONSTRAINT proxmox_storage_stor_id_key UNIQUE (stor_id);

ALTER TABLE ONLY public.proxmox_vms
    ADD CONSTRAINT proxmox_vms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.proxmox_vms
    ADD CONSTRAINT proxmox_vms_vm_id_key UNIQUE (vm_id);

ALTER TABLE ONLY public.quarterly_sla_config
    ADD CONSTRAINT quarterly_sla_config_pkey PRIMARY KEY (severity);

ALTER TABLE ONLY public.quarterly_snapshots
    ADD CONSTRAINT quarterly_snapshots_pkey PRIMARY KEY (quarter, year);

ALTER TABLE ONLY public.rdp_sessions
    ADD CONSTRAINT rdp_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.reboot_schedules
    ADD CONSTRAINT reboot_schedules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sap_employees
    ADD CONSTRAINT sap_employees_employee_id_key UNIQUE (employee_id);

ALTER TABLE ONLY public.sap_employees
    ADD CONSTRAINT sap_employees_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sap_users
    ADD CONSTRAINT sap_users_internal_key_key UNIQUE (internal_key);

ALTER TABLE ONLY public.sap_users
    ADD CONSTRAINT sap_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.scheduled_reports
    ADD CONSTRAINT scheduled_reports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_incidents
    ADD CONSTRAINT security_incidents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.service_monitor_events
    ADD CONSTRAINT service_monitor_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.software_deploy_jobs
    ADD CONSTRAINT software_deploy_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.software_inventory
    ADD CONSTRAINT software_inventory_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.software_packages
    ADD CONSTRAINT software_packages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.software_uninstall_jobs
    ADD CONSTRAINT software_uninstall_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sophos_alerts
    ADD CONSTRAINT sophos_alerts_alert_id_key UNIQUE (alert_id);

ALTER TABLE ONLY public.sophos_alerts
    ADD CONSTRAINT sophos_alerts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sophos_endpoints
    ADD CONSTRAINT sophos_endpoints_endpoint_id_key UNIQUE (endpoint_id);

ALTER TABLE ONLY public.sophos_endpoints
    ADD CONSTRAINT sophos_endpoints_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sophos_licenses
    ADD CONSTRAINT sophos_licenses_license_id_key UNIQUE (license_id);

ALTER TABLE ONLY public.sophos_licenses
    ADD CONSTRAINT sophos_licenses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ssl_certificates
    ADD CONSTRAINT ssl_certificates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.threat_exceptions
    ADD CONSTRAINT threat_exceptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.unitrends_alerts
    ADD CONSTRAINT unitrends_alerts_alert_id_key UNIQUE (alert_id);

ALTER TABLE ONLY public.unitrends_alerts
    ADD CONSTRAINT unitrends_alerts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.unitrends_backups
    ADD CONSTRAINT unitrends_backups_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.unitrends_clients
    ADD CONSTRAINT unitrends_clients_client_id_key UNIQUE (client_id);

ALTER TABLE ONLY public.unitrends_clients
    ADD CONSTRAINT unitrends_clients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.unitrends_storage
    ADD CONSTRAINT unitrends_storage_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ups_shutdown_event_agents
    ADD CONSTRAINT ups_shutdown_event_agents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ups_shutdown_events
    ADD CONSTRAINT ups_shutdown_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ups_shutdown_policies
    ADD CONSTRAINT ups_shutdown_policies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ups_shutdown_policy_agents
    ADD CONSTRAINT ups_shutdown_policy_agents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ups_shutdown_policy_agents
    ADD CONSTRAINT ups_shutdown_policy_agents_policy_id_agent_id_key UNIQUE (policy_id, agent_id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);

ALTER TABLE ONLY public.vmware_clusters
    ADD CONSTRAINT vmware_clusters_cluster_id_key UNIQUE (cluster_id);

ALTER TABLE ONLY public.vmware_clusters
    ADD CONSTRAINT vmware_clusters_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vmware_datastores
    ADD CONSTRAINT vmware_datastores_ds_id_key UNIQUE (ds_id);

ALTER TABLE ONLY public.vmware_datastores
    ADD CONSTRAINT vmware_datastores_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vmware_hosts
    ADD CONSTRAINT vmware_hosts_host_id_key UNIQUE (host_id);

ALTER TABLE ONLY public.vmware_hosts
    ADD CONSTRAINT vmware_hosts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vmware_vms
    ADD CONSTRAINT vmware_vms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vmware_vms
    ADD CONSTRAINT vmware_vms_vm_id_key UNIQUE (vm_id);

CREATE INDEX _hyper_1_32_chunk_idx_metrics_agent_time ON _timescaledb_internal._hyper_1_32_chunk USING btree (agent_id, "time" DESC);

CREATE INDEX _hyper_1_32_chunk_idx_metrics_name ON _timescaledb_internal._hyper_1_32_chunk USING btree (metric_name, "time" DESC);

CREATE INDEX _hyper_1_32_chunk_metrics_time_idx ON _timescaledb_internal._hyper_1_32_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_1_36_chunk_idx_metrics_agent_time ON _timescaledb_internal._hyper_1_36_chunk USING btree (agent_id, "time" DESC);

CREATE INDEX _hyper_1_36_chunk_idx_metrics_name ON _timescaledb_internal._hyper_1_36_chunk USING btree (metric_name, "time" DESC);

CREATE INDEX _hyper_1_36_chunk_metrics_time_idx ON _timescaledb_internal._hyper_1_36_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_1_39_chunk_idx_metrics_agent_time ON _timescaledb_internal._hyper_1_39_chunk USING btree (agent_id, "time" DESC);

CREATE INDEX _hyper_1_39_chunk_idx_metrics_name ON _timescaledb_internal._hyper_1_39_chunk USING btree (metric_name, "time" DESC);

CREATE INDEX _hyper_1_39_chunk_metrics_time_idx ON _timescaledb_internal._hyper_1_39_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_1_413_chunk_idx_metrics_agent_time ON _timescaledb_internal._hyper_1_413_chunk USING btree (agent_id, "time" DESC);

CREATE INDEX _hyper_1_413_chunk_idx_metrics_name ON _timescaledb_internal._hyper_1_413_chunk USING btree (metric_name, "time" DESC);

CREATE INDEX _hyper_1_413_chunk_metrics_time_idx ON _timescaledb_internal._hyper_1_413_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_1_418_chunk_idx_metrics_agent_time ON _timescaledb_internal._hyper_1_418_chunk USING btree (agent_id, "time" DESC);

CREATE INDEX _hyper_1_418_chunk_idx_metrics_name ON _timescaledb_internal._hyper_1_418_chunk USING btree (metric_name, "time" DESC);

CREATE INDEX _hyper_1_418_chunk_metrics_time_idx ON _timescaledb_internal._hyper_1_418_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_1_42_chunk_idx_metrics_agent_time ON _timescaledb_internal._hyper_1_42_chunk USING btree (agent_id, "time" DESC);

CREATE INDEX _hyper_1_42_chunk_idx_metrics_name ON _timescaledb_internal._hyper_1_42_chunk USING btree (metric_name, "time" DESC);

CREATE INDEX _hyper_1_42_chunk_metrics_time_idx ON _timescaledb_internal._hyper_1_42_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_11_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_11_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_11_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_11_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_13_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_13_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_13_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_13_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_15_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_15_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_15_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_15_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_17_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_17_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_17_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_17_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_19_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_19_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_19_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_19_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_22_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_22_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_22_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_22_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_24_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_24_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_24_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_24_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_26_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_26_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_26_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_26_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_28_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_28_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_28_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_28_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_2_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_2_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_2_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_2_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_31_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_31_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_31_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_31_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_33_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_33_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_33_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_33_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_35_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_35_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_35_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_35_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_38_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_38_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_38_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_38_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_3_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_3_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_3_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_3_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_412_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_412_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_412_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_412_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_415_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_415_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_415_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_415_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_417_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_417_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_417_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_417_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_5_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_5_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_5_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_5_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_7_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_7_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_7_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_7_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_7_9_chunk_idx_monitor_results_id_time ON _timescaledb_internal._hyper_7_9_chunk USING btree (monitor_id, "time" DESC);

CREATE INDEX _hyper_7_9_chunk_monitor_results_time_idx ON _timescaledb_internal._hyper_7_9_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_8_21_chunk_idx_siem_agent_time ON _timescaledb_internal._hyper_8_21_chunk USING btree (agent_id, "time" DESC);

CREATE INDEX _hyper_8_21_chunk_idx_siem_event_id ON _timescaledb_internal._hyper_8_21_chunk USING btree (event_id) WHERE (event_id IS NOT NULL);

CREATE INDEX _hyper_8_21_chunk_idx_siem_level_time ON _timescaledb_internal._hyper_8_21_chunk USING btree (level, "time" DESC);

CREATE INDEX _hyper_8_21_chunk_idx_siem_source_time ON _timescaledb_internal._hyper_8_21_chunk USING btree (log_source, "time" DESC);

CREATE INDEX _hyper_8_21_chunk_siem_events_time_idx ON _timescaledb_internal._hyper_8_21_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_9_34_chunk_apc_ups_metrics_time_idx ON _timescaledb_internal._hyper_9_34_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_9_37_chunk_apc_ups_metrics_time_idx ON _timescaledb_internal._hyper_9_37_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_9_40_chunk_apc_ups_metrics_time_idx ON _timescaledb_internal._hyper_9_40_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_9_414_chunk_apc_ups_metrics_time_idx ON _timescaledb_internal._hyper_9_414_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_9_416_chunk_apc_ups_metrics_time_idx ON _timescaledb_internal._hyper_9_416_chunk USING btree ("time" DESC);

CREATE INDEX _hyper_9_43_chunk_apc_ups_metrics_time_idx ON _timescaledb_internal._hyper_9_43_chunk USING btree ("time" DESC);

CREATE INDEX _materialized_hypertable_2_agent_id_bucket_idx ON _timescaledb_internal._materialized_hypertable_2 USING btree (agent_id, bucket DESC);

CREATE INDEX _materialized_hypertable_2_bucket_idx ON _timescaledb_internal._materialized_hypertable_2 USING btree (bucket DESC);

CREATE INDEX _materialized_hypertable_2_metric_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_2 USING btree (metric_name, bucket DESC);

CREATE UNIQUE INDEX agent_licenses_unique ON public.agent_licenses USING btree (agent_id, software_name);

CREATE UNIQUE INDEX agent_vulns_unique ON public.agent_vulnerabilities USING btree (agent_id, cve_id, software_name);

CREATE INDEX apc_ups_metrics_time_idx ON public.apc_ups_metrics USING btree ("time" DESC);

CREATE INDEX events_time_idx ON public.events USING btree ("time" DESC);

CREATE INDEX idx_ad_action_agent ON public.ad_action_log USING btree (agent_id, created_at DESC);

CREATE INDEX idx_ad_deleted_agent ON public.ad_deleted_users USING btree (agent_id, deleted_at DESC);

CREATE INDEX idx_ad_events_agent_time ON public.ad_events USING btree (agent_id, event_time DESC);

CREATE INDEX idx_ad_events_user ON public.ad_events USING btree (agent_id, target_user, event_time DESC);

CREATE INDEX idx_ad_groups_agent ON public.ad_groups USING btree (agent_id);

CREATE INDEX idx_ad_health_agent ON public.ad_health_snapshots USING btree (agent_id, snapped_at DESC);

CREATE INDEX idx_ad_users_agent ON public.ad_users USING btree (agent_id);

CREATE INDEX idx_ad_users_locked ON public.ad_users USING btree (agent_id, locked_out);

CREATE INDEX idx_agent_commands_agent ON public.agent_commands USING btree (agent_id, picked_up_at);

CREATE UNIQUE INDEX idx_agent_commands_pending_type ON public.agent_commands USING btree (agent_id, command_type) WHERE (picked_up_at IS NULL);

CREATE INDEX idx_agent_high_risk_agent ON public.agent_high_risk_software USING btree (agent_id);

CREATE INDEX idx_agent_history_agent ON public.agent_history USING btree (agent_id, created_at DESC);

CREATE INDEX idx_agent_licenses_agent ON public.agent_licenses USING btree (agent_id);

CREATE INDEX idx_agent_licenses_status ON public.agent_licenses USING btree (activation_status);

CREATE INDEX idx_agent_misconfigs_agent ON public.agent_misconfigs USING btree (agent_id);

CREATE INDEX idx_agent_misconfigs_rule ON public.agent_misconfigs USING btree (rule_id);

CREATE INDEX idx_agent_patches_agent ON public.agent_patches USING btree (agent_id);

CREATE INDEX idx_agent_ports_agent ON public.agent_open_ports USING btree (agent_id);

CREATE INDEX idx_agent_vulns_agent ON public.agent_vulnerabilities USING btree (agent_id);

CREATE INDEX idx_agent_vulns_cve ON public.agent_vulnerabilities USING btree (cve_id);

CREATE INDEX idx_agent_vulns_status ON public.agent_vulnerabilities USING btree (status);

CREATE INDEX idx_agents_hostname ON public.agents USING btree (hostname);

CREATE INDEX idx_agents_ip ON public.agents USING btree (ip_address);

CREATE INDEX idx_agents_os_type ON public.agents USING btree (os_type);

CREATE INDEX idx_agents_status ON public.agents USING btree (status);

CREATE INDEX idx_alerts_agent ON public.alerts USING btree (agent_id);

CREATE INDEX idx_alerts_status ON public.alerts USING btree (status);

CREATE INDEX idx_audit_agent ON public.audit_log USING btree (agent_id);

CREATE INDEX idx_audit_time ON public.audit_log USING btree ("timestamp" DESC);

CREATE INDEX idx_audit_user ON public.audit_log USING btree (user_id);

CREATE INDEX idx_awe_agent ON public.agent_watchdog_events USING btree (agent_id, triggered_at DESC);

CREATE INDEX idx_awe_time ON public.agent_watchdog_events USING btree (triggered_at DESC);

CREATE INDEX idx_bot_audit_agent ON public.bot_audit_log USING btree (agent_id);

CREATE INDEX idx_bot_audit_pid ON public.bot_audit_log USING btree (platform, platform_id);

CREATE INDEX idx_bot_audit_ts ON public.bot_audit_log USING btree (ts DESC);

CREATE INDEX idx_bot_users_platform ON public.bot_users USING btree (platform, platform_id);

CREATE INDEX idx_compliance_snap_date ON public.compliance_snapshots USING btree (snapshot_date);

CREATE INDEX idx_events_agent ON public.events USING btree (agent_id, "time" DESC);

CREATE INDEX idx_events_severity ON public.events USING btree (severity, "time" DESC);

CREATE UNIQUE INDEX idx_hw_agent ON public.hardware_inventory USING btree (agent_id);

CREATE INDEX idx_maint_history_patch_job ON public.maintenance_history USING btree (patch_job_id);

CREATE INDEX idx_metrics_agent_time ON public.metrics USING btree (agent_id, "time" DESC);

CREATE INDEX idx_metrics_name ON public.metrics USING btree (metric_name, "time" DESC);

CREATE INDEX idx_monitor_results_id_time ON public.monitor_results USING btree (monitor_id, "time" DESC);

CREATE INDEX idx_patch_jobs_agent ON public.patch_jobs USING btree (agent_id);

CREATE INDEX idx_patch_jobs_status ON public.patch_jobs USING btree (status);

CREATE INDEX idx_phishing_targets_campaign ON public.phishing_targets USING btree (campaign_id);

CREATE INDEX idx_phishing_targets_token ON public.phishing_targets USING btree (token);

CREATE INDEX idx_port_results_port_time ON public.port_check_results USING btree (port_id, "time" DESC);

CREATE INDEX idx_rdp_sessions_agent ON public.rdp_sessions USING btree (agent_id, logon_time DESC);

CREATE UNIQUE INDEX idx_rdp_sessions_dedup ON public.rdp_sessions USING btree (agent_id, username, session_id, logon_time);

CREATE INDEX idx_rdp_sessions_time ON public.rdp_sessions USING btree (logon_time DESC);

CREATE INDEX idx_schedule_runs_schedule_id ON public.patch_schedule_runs USING btree (schedule_id);

CREATE INDEX idx_siem_agent_time ON public.siem_events USING btree (agent_id, "time" DESC);

CREATE INDEX idx_siem_event_id ON public.siem_events USING btree (event_id) WHERE (event_id IS NOT NULL);

CREATE INDEX idx_siem_level_time ON public.siem_events USING btree (level, "time" DESC);

CREATE INDEX idx_siem_source_time ON public.siem_events USING btree (log_source, "time" DESC);

CREATE INDEX idx_sme_agent ON public.service_monitor_events USING btree (agent_id, triggered_at DESC);

CREATE INDEX idx_sme_time ON public.service_monitor_events USING btree (triggered_at DESC);

CREATE INDEX idx_svc_agent ON public.services USING btree (agent_id);

CREATE UNIQUE INDEX idx_svc_agent_name ON public.services USING btree (agent_id, service_name);

CREATE INDEX idx_svclog_agent ON public.service_status_log USING btree (agent_id, "time" DESC);

CREATE INDEX idx_sw_agent ON public.software_inventory USING btree (agent_id);

CREATE INDEX idx_sw_name ON public.software_inventory USING btree (name);

CREATE INDEX idx_update_history_agent ON public.agent_update_history USING btree (agent_id, installed_at DESC);

CREATE INDEX idx_webconfig_agent ON public.agent_webconfig_findings USING btree (agent_id);

CREATE INDEX metrics_time_idx ON public.metrics USING btree ("time" DESC);

CREATE INDEX monitor_results_time_idx ON public.monitor_results USING btree ("time" DESC);

CREATE INDEX port_check_results_time_idx ON public.port_check_results USING btree ("time" DESC);

CREATE INDEX service_status_log_time_idx ON public.service_status_log USING btree ("time" DESC);

CREATE INDEX siem_events_time_idx ON public.siem_events USING btree ("time" DESC);

CREATE INDEX uptime_checks_time_idx ON public.uptime_checks USING btree ("time" DESC);

ALTER TABLE ONLY _timescaledb_internal._hyper_7_11_chunk
    ADD CONSTRAINT "11_6_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_13_chunk
    ADD CONSTRAINT "13_7_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_15_chunk
    ADD CONSTRAINT "15_8_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_17_chunk
    ADD CONSTRAINT "17_9_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_19_chunk
    ADD CONSTRAINT "19_10_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_8_21_chunk
    ADD CONSTRAINT "21_11_siem_events_agent_id_fkey" FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_22_chunk
    ADD CONSTRAINT "22_12_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_24_chunk
    ADD CONSTRAINT "24_13_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_26_chunk
    ADD CONSTRAINT "26_14_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_28_chunk
    ADD CONSTRAINT "28_15_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_2_chunk
    ADD CONSTRAINT "2_1_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_31_chunk
    ADD CONSTRAINT "31_16_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_33_chunk
    ADD CONSTRAINT "33_17_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_9_34_chunk
    ADD CONSTRAINT "34_18_apc_ups_metrics_device_id_fkey" FOREIGN KEY (device_id) REFERENCES public.apc_ups_devices(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_35_chunk
    ADD CONSTRAINT "35_19_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_9_37_chunk
    ADD CONSTRAINT "37_20_apc_ups_metrics_device_id_fkey" FOREIGN KEY (device_id) REFERENCES public.apc_ups_devices(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_38_chunk
    ADD CONSTRAINT "38_21_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_3_chunk
    ADD CONSTRAINT "3_2_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_9_40_chunk
    ADD CONSTRAINT "40_22_apc_ups_metrics_device_id_fkey" FOREIGN KEY (device_id) REFERENCES public.apc_ups_devices(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_412_chunk
    ADD CONSTRAINT "412_393_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_9_414_chunk
    ADD CONSTRAINT "414_395_apc_ups_metrics_device_id_fkey" FOREIGN KEY (device_id) REFERENCES public.apc_ups_devices(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_415_chunk
    ADD CONSTRAINT "415_394_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_9_416_chunk
    ADD CONSTRAINT "416_396_apc_ups_metrics_device_id_fkey" FOREIGN KEY (device_id) REFERENCES public.apc_ups_devices(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_417_chunk
    ADD CONSTRAINT "417_397_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_9_43_chunk
    ADD CONSTRAINT "43_24_apc_ups_metrics_device_id_fkey" FOREIGN KEY (device_id) REFERENCES public.apc_ups_devices(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_5_chunk
    ADD CONSTRAINT "5_3_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_7_chunk
    ADD CONSTRAINT "7_4_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY _timescaledb_internal._hyper_7_9_chunk
    ADD CONSTRAINT "9_5_monitor_results_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.ad_action_log
    ADD CONSTRAINT ad_action_log_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.ad_action_log
    ADD CONSTRAINT ad_action_log_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.ad_configs
    ADD CONSTRAINT ad_configs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.ad_deleted_users
    ADD CONSTRAINT ad_deleted_users_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.ad_events
    ADD CONSTRAINT ad_events_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.ad_groups
    ADD CONSTRAINT ad_groups_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.ad_health_snapshots
    ADD CONSTRAINT ad_health_snapshots_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.ad_test_results
    ADD CONSTRAINT ad_test_results_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.ad_users
    ADD CONSTRAINT ad_users_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_commands
    ADD CONSTRAINT agent_commands_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_high_risk_software
    ADD CONSTRAINT agent_high_risk_software_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_high_risk_software
    ADD CONSTRAINT agent_high_risk_software_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.high_risk_rules(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_history
    ADD CONSTRAINT agent_history_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_open_ports
    ADD CONSTRAINT agent_open_ports_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_patches
    ADD CONSTRAINT agent_patches_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_security_state
    ADD CONSTRAINT agent_security_state_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_ssh_credentials
    ADD CONSTRAINT agent_ssh_credentials_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_update_history
    ADD CONSTRAINT agent_update_history_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_watchdog_events
    ADD CONSTRAINT agent_watchdog_events_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_webconfig_findings
    ADD CONSTRAINT agent_webconfig_findings_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.alert_rules(id);

ALTER TABLE ONLY public.apc_ups_metrics
    ADD CONSTRAINT apc_ups_metrics_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.apc_ups_devices(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.bot_audit_log
    ADD CONSTRAINT bot_audit_log_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.consolidation_plans
    ADD CONSTRAINT consolidation_plans_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.consolidation_plans
    ADD CONSTRAINT consolidation_plans_destination_server_id_fkey FOREIGN KEY (destination_server_id) REFERENCES public.agents(id);

ALTER TABLE ONLY public.deployment_jobs
    ADD CONSTRAINT deployment_jobs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.disk_volume_settings
    ADD CONSTRAINT disk_volume_settings_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.hardware_inventory
    ADD CONSTRAINT hardware_inventory_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.maintenance_cycle_agents
    ADD CONSTRAINT maintenance_cycle_agents_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.maintenance_cycle_agents
    ADD CONSTRAINT maintenance_cycle_agents_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.maintenance_cycles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.maintenance_cycles
    ADD CONSTRAINT maintenance_cycles_linked_cycle_id_fkey FOREIGN KEY (linked_cycle_id) REFERENCES public.maintenance_cycles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.maintenance_history
    ADD CONSTRAINT maintenance_history_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.maintenance_history
    ADD CONSTRAINT maintenance_history_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.maintenance_cycles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.maintenance_history
    ADD CONSTRAINT maintenance_history_patch_job_id_fkey FOREIGN KEY (patch_job_id) REFERENCES public.patch_jobs(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.maintenance_reports
    ADD CONSTRAINT maintenance_reports_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.maintenance_cycles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.monitor_results
    ADD CONSTRAINT monitor_results_monitor_id_fkey FOREIGN KEY (monitor_id) REFERENCES public.monitors(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.monitors
    ADD CONSTRAINT monitors_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.monitors
    ADD CONSTRAINT monitors_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.agent_groups(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.patch_jobs
    ADD CONSTRAINT patch_jobs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.phishing_targets
    ADD CONSTRAINT phishing_targets_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.phishing_campaigns(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.port_check_results
    ADD CONSTRAINT port_check_results_port_id_fkey FOREIGN KEY (port_id) REFERENCES public.monitored_ports(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.rdp_sessions
    ADD CONSTRAINT rdp_sessions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.reboot_schedules
    ADD CONSTRAINT reboot_schedules_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.reboot_schedules
    ADD CONSTRAINT reboot_schedules_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.agent_groups(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);

ALTER TABLE ONLY public.scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.agent_groups(id);

ALTER TABLE ONLY public.service_monitor_events
    ADD CONSTRAINT service_monitor_events_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.siem_events
    ADD CONSTRAINT siem_events_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.software_deploy_jobs
    ADD CONSTRAINT software_deploy_jobs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.software_inventory
    ADD CONSTRAINT software_inventory_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.software_uninstall_jobs
    ADD CONSTRAINT software_uninstall_jobs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.ssl_certificates
    ADD CONSTRAINT ssl_certificates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.ssl_certificates
    ADD CONSTRAINT ssl_certificates_renewed_from_id_fkey FOREIGN KEY (renewed_from_id) REFERENCES public.ssl_certificates(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.threat_exceptions
    ADD CONSTRAINT threat_exceptions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.ups_shutdown_event_agents
    ADD CONSTRAINT ups_shutdown_event_agents_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.ups_shutdown_events(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.ups_shutdown_events
    ADD CONSTRAINT ups_shutdown_events_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.apc_ups_devices(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.ups_shutdown_events
    ADD CONSTRAINT ups_shutdown_events_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.ups_shutdown_policies(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.ups_shutdown_policies
    ADD CONSTRAINT ups_shutdown_policies_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.apc_ups_devices(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.ups_shutdown_policy_agents
    ADD CONSTRAINT ups_shutdown_policy_agents_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.ups_shutdown_policy_agents
    ADD CONSTRAINT ups_shutdown_policy_agents_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.ups_shutdown_policies(id) ON DELETE CASCADE;

\unrestrict 6ZoYTeOfP5KKoJTuzGMEyWvFqAl3YhrqSGJosHJNugLUOi0p7EGeIby2p2H36rq


-- ─────────────────────────────────────────────────────────────────────────────
-- TimescaleDB Retention Policies
-- ─────────────────────────────────────────────────────────────────────────────
SELECT add_retention_policy('metrics',            INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('service_status_log', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('events',             INTERVAL '90 days', if_not_exists => TRUE);
SELECT add_retention_policy('uptime_checks',      INTERVAL '30 days', if_not_exists => TRUE);
