export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

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
            referencedRelation: "invoices"
            referencedColumns: ["shop_id", "id"]
          },
        ]
      }
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
          backdated_reason: string | null
          business_date: string
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
          backdated_reason?: string | null
          business_date: string
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
          backdated_reason?: string | null
          business_date?: string
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
          created_at: string
          created_by: string | null
          description: string
          id: string
          recorded_at: string
          shop_id: string
        }
        Insert: {
          amount_dirham: number
          business_date: string
          created_at?: string
          created_by?: string | null
          description: string
          id?: string
          recorded_at?: string
          shop_id: string
        }
        Update: {
          amount_dirham?: number
          business_date?: string
          created_at?: string
          created_by?: string | null
          description?: string
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
      invoice_effective_balances: {
        Row: {
          canonical_invoice_id: string
          shop_id: string
          effective_total_dirham: number
          effective_paid_dirham: number
          effective_due_dirham: number
        }
        Relationships: []
      }
    }
    Functions: {
      approve_overpayment: { Args: { command: Json }; Returns: Json }
      record_payment: { Args: { command: Json }; Returns: Json }
      submit_batch: { Args: { command: Json }; Returns: Json }
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
