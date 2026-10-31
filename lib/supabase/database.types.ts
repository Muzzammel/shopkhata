export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

type TableShape<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] };

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      attachments: {
        Row: {
          batch_id: string | null
          byte_size: number | null
          content_type: string | null
          created_at: string
          created_by: string | null
          file_name: string
          file_path: string
          id: string
          idempotency_key: string | null
          fingerprint: string | null
          expense_id: string | null
          invoice_id: string | null
          note: string | null
          shop_id: string
        }
        Insert: {
          batch_id?: string | null
          byte_size?: number | null
          content_type?: string | null
          created_at?: string
          created_by?: string | null
          file_name: string
          file_path: string
          id?: string
          idempotency_key?: string | null
          fingerprint?: string | null
          expense_id?: string | null
          invoice_id?: string | null
          note?: string | null
          shop_id: string
        }
        Update: {
          batch_id?: string | null
          byte_size?: number | null
          content_type?: string | null
          created_at?: string
          created_by?: string | null
          file_name?: string
          file_path?: string
          id?: string
          idempotency_key?: string | null
          fingerprint?: string | null
          expense_id?: string | null
          invoice_id?: string | null
          note?: string | null
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attachments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attachments_shop_id_batch_id_fkey"
            columns: ["shop_id", "batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["shop_id", "id"]
          },
          {
            foreignKeyName: "attachments_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attachments_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "effective_invoices"
            referencedColumns: ["shop_id", "canonical_invoice_id"]
          },
          {
            foreignKeyName: "attachments_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoice_effective_balances"
            referencedColumns: ["shop_id", "canonical_invoice_id"]
          },
          {
            foreignKeyName: "attachments_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["shop_id", "id"]
          },
        ]
      }
      customer_payment_batches: TableShape<{
        id: string; shop_id: string; customer_id: string; amount_dirham: number; business_date: string;
        idempotency_key: string; fingerprint: string; idempotency_result: Json; created_by: string; recorded_at: string;
      }>
      credit_application_batches: TableShape<{
        id: string; shop_id: string; customer_id: string; amount_dirham: number; business_date: string;
        idempotency_key: string; fingerprint: string; idempotency_result: Json; created_by: string; recorded_at: string;
      }>
      credit_applications: TableShape<{
        id: string; shop_id: string; customer_id: string; batch_id: string; credit_id: string; invoice_id: string;
        amount_dirham: number; business_date: string; recorded_at: string; created_by: string;
      }>
      backup_records: TableShape<{
        id: string; backup_created_at: string; environment: string; source: string; app_version: string | null; git_commit: string | null; latest_migration: string;
        dump_bytes: number; receipt_count: number; manifest_sha256: string; restore_verified_at: string | null; restore_verified_ok: boolean | null; recorded_at: string;
      }>
      expense_correction_requests: TableShape<{
        id: string; shop_id: string; expense_id: string; amount_dirham: number; expected_correction_request_id: string | null; category: string; description: string;
        reason: string; requested_by: string; requested_at: string; idempotency_key: string; fingerprint: string;
      }>
      expense_correction_decisions: TableShape<{
        id: string; shop_id: string; request_id: string; expense_id: string; decision: string; reason: string | null;
        decided_by: string; decided_at: string; idempotency_key: string; fingerprint: string;
      }>
      audit_events: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          metadata: Json
          reason: string | null
          recorded_at: string
          shop_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          metadata?: Json
          reason?: string | null
          recorded_at?: string
          shop_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          metadata?: Json
          reason?: string | null
          recorded_at?: string
          shop_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_events_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
        ]
      }
      batches: {
        Row: {
          business_date: string
          backdated_reason: string | null
          created_at: string
          created_by: string | null
          fingerprint: string | null
          id: string
          idempotency_key: string | null
          idempotency_result: Json | null
          is_backdated: boolean
          recorded_at: string
          shop_id: string
        }
        Insert: {
          business_date: string
          backdated_reason?: string | null
          created_at?: string
          created_by?: string | null
          fingerprint?: string | null
          id?: string
          idempotency_key?: string | null
          idempotency_result?: Json | null
          is_backdated?: boolean
          recorded_at?: string
          shop_id: string
        }
        Update: {
          business_date?: string
          backdated_reason?: string | null
          created_at?: string
          created_by?: string | null
          fingerprint?: string | null
          id?: string
          idempotency_key?: string | null
          idempotency_result?: Json | null
          is_backdated?: boolean
          recorded_at?: string
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batches_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
        ]
      }
      correction_decisions: {
        Row: {
          decided_at: string
          decided_by: string
          decision: string
          expected_revision: number
          fingerprint: string
          id: string
          idempotency_key: string
          invoice_id: string
          reason: string | null
          request_id: string
          revision: number | null
          shop_id: string
        }
        Insert: {
          decided_at?: string
          decided_by: string
          decision: string
          expected_revision: number
          fingerprint: string
          id?: string
          idempotency_key: string
          invoice_id: string
          reason?: string | null
          request_id: string
          revision?: number | null
          shop_id: string
        }
        Update: {
          decided_at?: string
          decided_by?: string
          decision?: string
          expected_revision?: number
          fingerprint?: string
          id?: string
          idempotency_key?: string
          invoice_id?: string
          reason?: string | null
          request_id?: string
          revision?: number | null
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "correction_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "correction_decisions_shop_id_request_id_invoice_id_fkey"
            columns: ["shop_id", "request_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "correction_requests"
            referencedColumns: ["shop_id", "id", "invoice_id"]
          },
        ]
      }
      correction_requests: {
        Row: {
          amount_delta_dirham: number
          corrected_total_dirham: number | null
          expected_total_dirham: number | null
          fingerprint: string
          id: string
          idempotency_key: string
          invoice_id: string
          payment_id: string | null
          reason: string
          requested_at: string
          requested_by: string
          shop_id: string
        }
        Insert: {
          amount_delta_dirham: number
          corrected_total_dirham?: number | null
          expected_total_dirham?: number | null
          fingerprint: string
          id?: string
          idempotency_key: string
          invoice_id: string
          payment_id?: string | null
          reason: string
          requested_at?: string
          requested_by: string
          shop_id: string
        }
        Update: {
          amount_delta_dirham?: number
          corrected_total_dirham?: number | null
          expected_total_dirham?: number | null
          fingerprint?: string
          id?: string
          idempotency_key?: string
          invoice_id?: string
          payment_id?: string | null
          reason?: string
          requested_at?: string
          requested_by?: string
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "correction_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "correction_requests_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "correction_requests_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "effective_invoices"
            referencedColumns: ["shop_id", "canonical_invoice_id"]
          },
          {
            foreignKeyName: "correction_requests_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoice_effective_balances"
            referencedColumns: ["shop_id", "canonical_invoice_id"]
          },
          {
            foreignKeyName: "correction_requests_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["shop_id", "id"]
          },
          {
            foreignKeyName: "correction_requests_shop_id_payment_id_fkey"
            columns: ["shop_id", "payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["shop_id", "id"]
          },
        ]
      }
      corrections: {
        Row: {
          amount_delta_dirham: number
          approved_by: string | null
          business_date: string
          created_at: string
          created_by: string | null
          id: string
          invoice_id: string | null
          payment_id: string | null
          reason: string
          recorded_at: string
          request_id: string | null
          shop_id: string
        }
        Insert: {
          amount_delta_dirham: number
          approved_by?: string | null
          business_date: string
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_id?: string | null
          payment_id?: string | null
          reason: string
          recorded_at?: string
          request_id?: string | null
          shop_id: string
        }
        Update: {
          amount_delta_dirham?: number
          approved_by?: string | null
          business_date?: string
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_id?: string | null
          payment_id?: string | null
          reason?: string
          recorded_at?: string
          request_id?: string | null
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "corrections_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "corrections_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "corrections_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: true
            referencedRelation: "correction_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "corrections_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "corrections_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "effective_invoices"
            referencedColumns: ["shop_id", "canonical_invoice_id"]
          },
          {
            foreignKeyName: "corrections_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoice_effective_balances"
            referencedColumns: ["shop_id", "canonical_invoice_id"]
          },
          {
            foreignKeyName: "corrections_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["shop_id", "id"]
          },
          {
            foreignKeyName: "corrections_shop_id_payment_id_fkey"
            columns: ["shop_id", "payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["shop_id", "id"]
          },
        ]
      }
      customer_credits: {
        Row: {
          amount_dirham: number
          approved_at: string | null
          approved_by: string | null
          business_date: string
          created_at: string
          created_by: string | null
          customer_id: string
          id: string
          invoice_id: string | null
          payment_method: string
          reason: string | null
          recorded_at: string
          shop_id: string
        }
        Insert: {
          amount_dirham: number
          approved_at?: string | null
          approved_by?: string | null
          business_date: string
          created_at?: string
          created_by?: string | null
          customer_id: string
          id?: string
          invoice_id?: string | null
          payment_method?: string
          reason?: string | null
          recorded_at?: string
          shop_id: string
        }
        Update: {
          amount_dirham?: number
          approved_at?: string | null
          approved_by?: string | null
          business_date?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string
          id?: string
          invoice_id?: string | null
          payment_method?: string
          reason?: string | null
          recorded_at?: string
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_credits_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_credits_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_credits_shop_id_customer_id_fkey"
            columns: ["shop_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["shop_id", "id"]
          },
          {
            foreignKeyName: "customer_credits_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_credits_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "effective_invoices"
            referencedColumns: ["shop_id", "canonical_invoice_id"]
          },
          {
            foreignKeyName: "customer_credits_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoice_effective_balances"
            referencedColumns: ["shop_id", "canonical_invoice_id"]
          },
          {
            foreignKeyName: "customer_credits_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["shop_id", "id"]
          },
        ]
      }
      customers: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          mobile: string | null
          name: string | null
          public_id: string
          shop_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          mobile?: string | null
          name?: string | null
          public_id?: string
          shop_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          mobile?: string | null
          name?: string | null
          public_id?: string
          shop_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_closes: {
        Row: {
          actor_id: string | null
          business_date: string
          created_at: string
          event_sequence: number
          event_type: string
          id: string
          note: string | null
          reason: string | null
          recorded_at: string
          shop_id: string
        }
        Insert: {
          actor_id?: string | null
          business_date: string
          created_at?: string
          event_sequence?: never
          event_type?: string
          id?: string
          note?: string | null
          reason?: string | null
          recorded_at?: string
          shop_id: string
        }
        Update: {
          actor_id?: string | null
          business_date?: string
          created_at?: string
          event_sequence?: never
          event_type?: string
          id?: string
          note?: string | null
          reason?: string | null
          recorded_at?: string
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_closes_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_closes_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount_dirham: number
          business_date: string
          backdated_reason: string | null
          created_at: string
          created_by: string | null
          description: string
          category: string
          idempotency_key: string | null
          fingerprint: string | null
          idempotency_result: Json | null
          id: string
          recorded_at: string
          shop_id: string
        }
        Insert: {
          amount_dirham: number
          business_date: string
          backdated_reason?: string | null
          created_at?: string
          created_by?: string | null
          description: string
          category?: string
          idempotency_key?: string | null
          fingerprint?: string | null
          idempotency_result?: Json | null
          id?: string
          recorded_at?: string
          shop_id: string
        }
        Update: {
          amount_dirham?: number
          business_date?: string
          backdated_reason?: string | null
          created_at?: string
          created_by?: string | null
          description?: string
          category?: string
          idempotency_key?: string | null
          fingerprint?: string | null
          idempotency_result?: Json | null
          id?: string
          recorded_at?: string
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "expenses_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_number_registry: {
        Row: {
          canonical_invoice_id: string
          created_at: string
          id: string
          invoice_number: string
          normalized_invoice_number: string | null
          shop_id: string
        }
        Insert: {
          canonical_invoice_id: string
          created_at?: string
          id?: string
          invoice_number: string
          normalized_invoice_number?: string | null
          shop_id: string
        }
        Update: {
          canonical_invoice_id?: string
          created_at?: string
          id?: string
          invoice_number?: string
          normalized_invoice_number?: string | null
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_number_registry_shop_id_canonical_invoice_id_fkey"
            columns: ["shop_id", "canonical_invoice_id"]
            isOneToOne: false
            referencedRelation: "effective_invoices"
            referencedColumns: ["shop_id", "canonical_invoice_id"]
          },
          {
            foreignKeyName: "invoice_number_registry_shop_id_canonical_invoice_id_fkey"
            columns: ["shop_id", "canonical_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoice_effective_balances"
            referencedColumns: ["shop_id", "canonical_invoice_id"]
          },
          {
            foreignKeyName: "invoice_number_registry_shop_id_canonical_invoice_id_fkey"
            columns: ["shop_id", "canonical_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["shop_id", "id"]
          },
          {
            foreignKeyName: "invoice_number_registry_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          batch_id: string | null
          business_date: string
          created_at: string
          created_by: string | null
          customer_id: string | null
          delivered: boolean
          id: string
          invoice_id: string
          invoice_type: string
          note: string | null
          quantity: number
          recorded_at: string
          shop_id: string
          total_amount_dirham: number
        }
        Insert: {
          batch_id?: string | null
          business_date: string
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          delivered?: boolean
          id?: string
          invoice_id: string
          invoice_type?: string
          note?: string | null
          quantity?: number
          recorded_at?: string
          shop_id: string
          total_amount_dirham: number
        }
        Update: {
          batch_id?: string | null
          business_date?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          delivered?: boolean
          id?: string
          invoice_id?: string
          invoice_type?: string
          note?: string | null
          quantity?: number
          recorded_at?: string
          shop_id?: string
          total_amount_dirham?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_shop_id_batch_id_fkey"
            columns: ["shop_id", "batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["shop_id", "id"]
          },
          {
            foreignKeyName: "invoices_shop_id_customer_id_fkey"
            columns: ["shop_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["shop_id", "id"]
          },
          {
            foreignKeyName: "invoices_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_dirham: number
          batch_id: string | null
          business_date: string
          created_at: string
          created_by: string | null
          customer_payment_batch_id: string | null
          fingerprint: string | null
          id: string
          idempotency_key: string | null
          idempotency_result: Json | null
          invoice_id: string
          payment_method: string
          recorded_at: string
          shop_id: string
        }
        Insert: {
          amount_dirham: number
          batch_id?: string | null
          business_date: string
          created_at?: string
          created_by?: string | null
          customer_payment_batch_id?: string | null
          fingerprint?: string | null
          id?: string
          idempotency_key?: string | null
          idempotency_result?: Json | null
          invoice_id: string
          payment_method?: string
          recorded_at?: string
          shop_id: string
        }
        Update: {
          amount_dirham?: number
          batch_id?: string | null
          business_date?: string
          created_at?: string
          created_by?: string | null
          customer_payment_batch_id?: string | null
          fingerprint?: string | null
          id?: string
          idempotency_key?: string | null
          idempotency_result?: Json | null
          invoice_id?: string
          payment_method?: string
          recorded_at?: string
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_shop_id_batch_id_fkey"
            columns: ["shop_id", "batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["shop_id", "id"]
          },
          {
            foreignKeyName: "payments_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "effective_invoices"
            referencedColumns: ["shop_id", "canonical_invoice_id"]
          },
          {
            foreignKeyName: "payments_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoice_effective_balances"
            referencedColumns: ["shop_id", "canonical_invoice_id"]
          },
          {
            foreignKeyName: "payments_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["shop_id", "id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string
          email: string
          id: string
          is_active: boolean
          role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name: string
          email: string
          id: string
          is_active?: boolean
          role: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          email?: string
          id?: string
          is_active?: boolean
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
      replacement_decisions: {
        Row: {
          decided_at: string
          decided_by: string
          decision: string
          expected_revision: number
          fingerprint: string
          id: string
          idempotency_key: string
          invoice_id: string
          reason: string | null
          request_id: string
          revision: number | null
          shop_id: string
        }
        Insert: {
          decided_at?: string
          decided_by: string
          decision: string
          expected_revision: number
          fingerprint: string
          id?: string
          idempotency_key: string
          invoice_id: string
          reason?: string | null
          request_id: string
          revision?: number | null
          shop_id: string
        }
        Update: {
          decided_at?: string
          decided_by?: string
          decision?: string
          expected_revision?: number
          fingerprint?: string
          id?: string
          idempotency_key?: string
          invoice_id?: string
          reason?: string | null
          request_id?: string
          revision?: number | null
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "replacement_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "replacement_decisions_shop_id_request_id_invoice_id_fkey"
            columns: ["shop_id", "request_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "replacement_requests"
            referencedColumns: ["shop_id", "id", "invoice_id"]
          },
        ]
      }
      replacement_requests: {
        Row: {
          customer_id: string | null
          delivered: boolean
          expected_revision: number
          fingerprint: string
          id: string
          idempotency_key: string
          invoice_id: string
          invoice_number: string
          reason: string
          requested_at: string
          requested_by: string
          shop_id: string
        }
        Insert: {
          customer_id?: string | null
          delivered: boolean
          expected_revision: number
          fingerprint: string
          id?: string
          idempotency_key: string
          invoice_id: string
          invoice_number: string
          reason: string
          requested_at?: string
          requested_by: string
          shop_id: string
        }
        Update: {
          customer_id?: string | null
          delivered?: boolean
          expected_revision?: number
          fingerprint?: string
          id?: string
          idempotency_key?: string
          invoice_id?: string
          invoice_number?: string
          reason?: string
          requested_at?: string
          requested_by?: string
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "replacement_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "replacement_requests_shop_id_customer_id_fkey"
            columns: ["shop_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["shop_id", "id"]
          },
          {
            foreignKeyName: "replacement_requests_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "replacement_requests_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "effective_invoices"
            referencedColumns: ["shop_id", "canonical_invoice_id"]
          },
          {
            foreignKeyName: "replacement_requests_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoice_effective_balances"
            referencedColumns: ["shop_id", "canonical_invoice_id"]
          },
          {
            foreignKeyName: "replacement_requests_shop_id_invoice_id_fkey"
            columns: ["shop_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["shop_id", "id"]
          },
        ]
      }
      shops: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_shop_assignments: {
        Row: {
          created_at: string
          id: string
          shop_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          shop_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          shop_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_shop_assignments_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_shop_assignments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      effective_invoices: {
        Row: {
          business_date: string | null
          canonical_invoice_id: string | null
          created_by: string | null
          effective_customer_id: string | null
          effective_delivered: boolean | null
          effective_due_dirham: number | null
          effective_invoice_number: string | null
          effective_paid_dirham: number | null
          effective_credit_applied_dirham: number | null
          effective_total_dirham: number | null
          original_invoice_number: string | null
          original_total_dirham: number | null
          recorded_at: string | null
          revision: number | null
          shop_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_effective_balances: {
        Row: {
          canonical_invoice_id: string | null
          effective_due_dirham: number | null
          effective_paid_dirham: number | null
          effective_total_dirham: number | null
          shop_id: string | null
        }
        Insert: {
          canonical_invoice_id?: string | null
          effective_due_dirham?: never
          effective_paid_dirham?: never
          effective_total_dirham?: never
          shop_id?: string | null
        }
        Update: {
          canonical_invoice_id?: string | null
          effective_due_dirham?: never
          effective_paid_dirham?: never
          effective_total_dirham?: never
          shop_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_financial_balances: {
        Row: { shop_id: string | null; customer_id: string | null; outstanding_due_dirham: number | null; available_credit_dirham: number | null; invoice_count: number | null; last_activity_date: string | null }
        Relationships: []
      }
      customer_ledger: {
        Row: { shop_id: string | null; customer_id: string | null; business_date: string | null; recorded_at: string | null; sequence_id: string | null; entry_type: string | null; reference: string | null; invoice_number: string | null; actor_id: string | null; invoice_id: string | null; debit_dirham: number | null; credit_dirham: number | null }
        Relationships: []
      }
      report_payments: {
        Row: { shop_id: string | null; entry_id: string | null; business_date: string | null; recorded_at: string | null; source: string | null; method: string | null; amount_dirham: number | null; invoice_id: string | null; created_by: string | null; reference: string | null }
        Relationships: []
      }
      effective_expenses: {
        Row: { id: string | null; shop_id: string | null; business_date: string | null; recorded_at: string | null; created_by: string | null; description: string | null; amount_dirham: number | null; category: string | null; correction_request_id: string | null; backdated_reason: string | null }
        Relationships: []
      }
    }
    Functions: {
      approve_overpayment: { Args: { command: Json }; Returns: Json }
      decide_invoice_correction: { Args: { command: Json }; Returns: Json }
      decide_invoice_replacement: { Args: { command: Json }; Returns: Json }
      record_payment: { Args: { command: Json }; Returns: Json }
      request_invoice_correction: { Args: { command: Json }; Returns: Json }
      request_invoice_replacement: { Args: { command: Json }; Returns: Json }
      submit_batch: { Args: { command: Json }; Returns: Json }
      create_customer: { Args: { command: Json }; Returns: Json }
      record_customer_payment: { Args: { command: Json }; Returns: Json }
      apply_customer_credit: { Args: { command: Json }; Returns: Json }
      create_expense: { Args: { command: Json }; Returns: Json }
      request_expense_correction: { Args: { command: Json }; Returns: Json }
      decide_expense_correction: { Args: { command: Json }; Returns: Json }
      register_expense_attachment: { Args: { command: Json }; Returns: Json }
      close_business_date: { Args: { command: Json }; Returns: Json }
      reopen_business_date: { Args: { command: Json }; Returns: Json }
      admin_register_account: { Args: { command: Json }; Returns: Json }
      admin_update_account: { Args: { command: Json }; Returns: Json }
      admin_set_shop_assignment: { Args: { command: Json }; Returns: Json }
      admin_create_shop: { Args: { command: Json }; Returns: Json }
      admin_update_shop: { Args: { command: Json }; Returns: Json }
      report_daily_summary: { Args: { p_shop_id: string; p_from: string; p_to: string }; Returns: { business_date: string; invoice_count: number; gross_invoice_dirham: number; initial_received_dirham: number; due_created_dirham: number; followup_payments_dirham: number; customer_payments_dirham: number; payment_corrections_dirham: number; invoice_corrections_dirham: number; credit_created_dirham: number; credit_applied_dirham: number; expense_count: number; expenses_dirham: number; cash_received_dirham: number; bank_received_dirham: number; total_received_dirham: number; net_cash_movement_dirham: number; net_due_movement_dirham: number }[] }
      report_day_pending_requests: { Args: { p_shop_id: string; p_date: string }; Returns: { pending_invoice_corrections: number; pending_invoice_replacements: number; pending_expense_corrections: number }[] }
      report_payment_totals: { Args: { p_shop_id: string; p_from: string; p_to: string }; Returns: { source: string | null; method: string | null; entry_count: number; amount_dirham: number }[] }
      report_sales_totals: { Args: { p_shop_id: string; p_from: string; p_to: string }; Returns: { invoice_count: number; effective_total_dirham: number; effective_paid_dirham: number; credit_applied_dirham: number; effective_due_dirham: number; delivered_count: number; undelivered_count: number }[] }
      report_customer_due_totals: { Args: { p_shop_id: string }; Returns: { customers_with_due: number; outstanding_due_dirham: number; available_credit_dirham: number; unassigned_due_dirham: number }[] }
      report_expense_totals: { Args: { p_shop_id: string; p_from: string; p_to: string }; Returns: { category: string | null; expense_count: number; amount_dirham: number }[] }
      report_top_customers_by_sales: { Args: { p_shop_id: string; p_from: string; p_to: string; p_limit?: number }; Returns: { customer_id: string; name: string; amount_dirham: number }[] }
      report_top_customers_by_payments: { Args: { p_shop_id: string; p_from: string; p_to: string; p_limit?: number }; Returns: { customer_id: string; name: string; amount_dirham: number }[] }
      report_dashboard_snapshot: { Args: { p_shop_id: string; p_from: string; p_to: string; p_comparison_shop_ids?: string[] }; Returns: Json }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
