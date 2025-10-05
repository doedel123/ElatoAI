"use client";

import { useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { useToast } from "@/components/ui/use-toast";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { createClient } from "@/utils/supabase/client";
import { createPersonality } from "@/db/personalities";
import { v4 as uuidv4 } from 'uuid';

interface ElevenLabsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  selectedUser: IUser;
}

export default function ElevenLabsModal({ isOpen, onClose, onSuccess, selectedUser }: ElevenLabsModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [form, setForm] = useState({
    name: '',
    agentId: ''
  });
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const { toast } = useToast();
  const supabase = createClient();

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const personality = await createPersonality(supabase, selectedUser.user_id, {
        provider: 'elevenlabs' as ModelProvider,
        title: form.name,
        subtitle: "",
        character_prompt: "",
        oai_voice: form.agentId,
        voice_prompt: "",
        is_doctor: false,
        is_child_voice: false,
        is_story: false,
        key: form.name.toLowerCase().replace(/ /g, '_') + "_" + uuidv4(),
        creator_id: selectedUser.user_id,
        short_description: "",
        pitch_factor: 1,
        first_message_prompt: ""
      });

      if (personality) {
        onClose();
        setForm({ name: '', agentId: '' });
        toast({ description: 'ElevenLabs character added successfully!' });
        onSuccess?.();
      }
    } catch (error) {
      console.error('Error creating ElevenLabs character:', error);
      toast({ description: 'Failed to create character. Please try again.', variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  }, [form.name, form.agentId, onClose, onSuccess, toast, supabase, selectedUser.user_id]);

  const handleClose = useCallback(() => {
    onClose();
    setForm({ name: '', agentId: '' });
  }, [onClose]);

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setForm(prev => ({ ...prev, name: e.target.value }));
  }, []);

  const handleAgentIdChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setForm(prev => ({ ...prev, agentId: e.target.value }));
  }, []);

  const FormContent = useMemo(() => (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="elevenLabsName">Character Name</Label>
        <Input
          id="elevenLabsName"
          placeholder="My Eleven Labs Character"
          value={form.name}
          onChange={handleNameChange}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="elevenLabsAgentId">Agent ID</Label>
        <Input
          id="elevenLabsAgentId"
          placeholder="your-agent-id-here"
          value={form.agentId}
          onChange={handleAgentIdChange}
          required
        />
        <p className="text-xs text-gray-500">
          Find this in your Eleven Labs dashboard under your agent settings
        </p>
      </div>

      <div className="flex gap-3 pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={handleClose}
          className="flex-1"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={isSubmitting}
          className="flex-1"
        >
          {isSubmitting ? "Adding..." : "Add Character"}
        </Button>
      </div>
    </form>
  ), [form.name, form.agentId, handleSubmit, handleNameChange, handleAgentIdChange, handleClose, isSubmitting]);

  if (isDesktop) {
    return (
      <Dialog open={isOpen} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Eleven Labs Character</DialogTitle>
          </DialogHeader>
          {FormContent}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Drawer open={isOpen} onOpenChange={handleClose}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Add Eleven Labs Character</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-4">
          {FormContent}
        </div>
      </DrawerContent>
    </Drawer>
  );
}