
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { 
  Send, 
  Heart, 
  Sparkles, 
  Mic, 
  MessageSquare, 
  X, 
  Volume2, 
  Moon, 
  Sun,
  HandHeart,
  Waves
} from 'lucide-react';
import { Role, Message } from './types';
import { SYSTEM_INSTRUCTION } from './services/geminiService';

// Audio Helpers
// Manual implementation of encode/decode as required by guidelines
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Custom decoding for raw PCM audio stream
async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: Role.MODEL,
      text: "Hey! Main Jana hoon. Tumhara din kaisa ja raha hai? I'm so glad you're here to talk.",
      timestamp: new Date()
    }
  ]);
  const [inputText, setInputText] = useState('');
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  const currentInputTranscription = useRef('');
  const currentOutputTranscription = useRef('');

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const toggleDarkMode = () => setIsDarkMode(!isDarkMode);

  // Live API Session Setup
  const startLiveSession = async () => {
    try {
      setIsLoading(true);
      // Create a new GoogleGenAI instance right before making an API call for the latest key context
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setIsListening(true);
            setIsLoading(false);
            const source = audioContextInRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              // Always use sessionPromise to avoid race conditions with connection
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Process model's audio turn
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && audioContextOutRef.current) {
              const ctx = audioContextOutRef.current;
              // Synchronize audio playback chunks
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
            }

            // Handle barge-in interruptions
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            // Handle real-time transcriptions
            if (message.serverContent?.inputTranscription) {
              currentInputTranscription.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscription.current += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              if (currentInputTranscription.current || currentOutputTranscription.current) {
                setMessages(prev => [
                  ...prev,
                  ...(currentInputTranscription.current ? [{ role: Role.USER, text: currentInputTranscription.current, timestamp: new Date() }] : []),
                  ...(currentOutputTranscription.current ? [{ role: Role.MODEL, text: currentOutputTranscription.current, timestamp: new Date() }] : [])
                ]);
                currentInputTranscription.current = '';
                currentOutputTranscription.current = '';
              }
            }
          },
          onclose: () => stopLiveSession(),
          onerror: (e) => console.error("Live Error:", e)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { 
                prebuiltVoiceConfig: { 
                    voiceName: 'Kore' 
                } 
            },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        }
      });

      sessionRef.current = await sessionPromise;
      setIsLiveMode(true);
    } catch (err) {
      console.error("Failed to start live session:", err);
      setIsLoading(false);
    }
  };

  const stopLiveSession = () => {
    sessionRef.current?.close();
    sessionRef.current = null;
    setIsLiveMode(false);
    setIsListening(false);
    audioContextInRef.current?.close();
    audioContextOutRef.current?.close();
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || isLoading) return;

    const userMessage: Message = { role: Role.USER, text: inputText, timestamp: new Date() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInputText('');
    setIsLoading(true);

    try {
      // Create fresh instance for API call
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // Ensure contents starts with 'user' role as required by the API
      const validContents = newMessages
        .filter((m, index) => !(index === 0 && m.role === Role.MODEL))
        .map(m => ({ role: m.role, parts: [{ text: m.text }] }));

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: validContents,
        config: { systemInstruction: SYSTEM_INSTRUCTION }
      });

      const aiText = response.text || "I'm here for you.";
      setMessages(prev => [...prev, { role: Role.MODEL, text: aiText, timestamp: new Date() }]);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={`flex flex-col h-screen transition-all duration-700 ${isDarkMode ? 'bg-zinc-950 text-zinc-100' : 'bg-[#fffcfc] text-zinc-900'}`}>
      
      {/* Navigation */}
      <nav className={`px-6 py-4 flex items-center justify-between border-b ${isDarkMode ? 'bg-zinc-900/50 border-zinc-800' : 'bg-white/50 border-rose-50'} backdrop-blur-xl z-20`}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-rose-400 to-orange-300 flex items-center justify-center shadow-lg shadow-rose-200">
            <Heart className="text-white w-5 h-5 fill-current" />
          </div>
          <div>
            <h1 className="text-lg font-bold font-serif tracking-tight">Jana</h1>
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${isListening ? 'bg-rose-400 animate-pulse' : 'bg-rose-200'}`}></span>
              <span className="text-[10px] uppercase tracking-widest opacity-60 font-medium">Safe Presence</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={toggleDarkMode} className={`p-2.5 rounded-xl transition-colors ${isDarkMode ? 'hover:bg-zinc-800 text-yellow-400' : 'hover:bg-rose-50 text-rose-400'}`}>
            {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          {!isLiveMode ? (
            <button 
              onClick={startLiveSession}
              className="flex items-center gap-2 bg-rose-400 hover:bg-rose-500 text-white px-5 py-2.5 rounded-2xl text-sm font-semibold transition-all shadow-lg shadow-rose-100 active:scale-95"
            >
              <Mic size={18} />
              Talk to me
            </button>
          ) : (
            <button 
              onClick={stopLiveSession}
              className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-900 text-white px-5 py-2.5 rounded-2xl text-sm font-semibold transition-all shadow-lg shadow-zinc-900/10 active:scale-95"
            >
              <X size={18} />
              End Voice
            </button>
          )}
        </div>
      </nav>

      <div className="flex-1 relative overflow-hidden flex flex-col">
        {/* Chat History */}
        <div className={`flex-1 overflow-y-auto p-4 space-y-6 chat-scroll transition-all duration-700 ${isLiveMode ? 'opacity-10 blur-xl scale-90 pointer-events-none' : 'opacity-100 blur-0 scale-100'}`}>
          <div className="max-w-2xl mx-auto space-y-6 pt-6">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === Role.USER ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-4`}>
                <div className={`flex flex-col max-w-[85%] ${msg.role === Role.USER ? 'items-end' : 'items-start'}`}>
                  <div className={`px-5 py-3.5 rounded-3xl shadow-sm text-sm leading-relaxed ${
                    msg.role === Role.USER 
                      ? 'bg-rose-400 text-white rounded-tr-none' 
                      : `${isDarkMode ? 'bg-zinc-900 border-zinc-800 text-zinc-200' : 'bg-white border-rose-50 text-zinc-800'} rounded-tl-none border`
                  }`}>
                    {msg.text}
                  </div>
                  <span className="text-[10px] mt-2 opacity-40 font-medium tracking-wide">{msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </div>
            ))}
            {isLoading && !isLiveMode && (
              <div className="flex gap-2 text-rose-300 items-center pl-2">
                <div className="flex gap-1">
                    <span className="w-1 h-1 rounded-full bg-current animate-bounce"></span>
                    <span className="w-1 h-1 rounded-full bg-current animate-bounce [animation-delay:0.2s]"></span>
                    <span className="w-1 h-1 rounded-full bg-current animate-bounce [animation-delay:0.4s]"></span>
                </div>
                <span className="text-xs italic font-medium opacity-70">Jana is listening...</span>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        </div>

        {/* Live Voice Overlay */}
        {isLiveMode && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center p-8 text-center animate-in fade-in duration-1000">
            <div className="relative group">
              <div className="absolute inset-0 bg-rose-200 rounded-full animate-pulse-glow opacity-30"></div>
              <div className="absolute inset-[-40px] bg-rose-300/10 rounded-full animate-pulse-glow [animation-delay:1s]"></div>
              
              <div className={`relative w-56 h-56 rounded-full flex flex-col items-center justify-center border border-white/40 ${isDarkMode ? 'bg-zinc-900/80' : 'bg-white/80'} backdrop-blur-3xl shadow-[0_20px_50px_rgba(251,113,133,0.15)] overflow-hidden transition-transform duration-500 group-hover:scale-105`}>
                <div className="flex gap-1.5 mb-4">
                  {[...Array(7)].map((_, i) => (
                    <div 
                      key={i} 
                      className="w-1.5 bg-rose-400 rounded-full animate-wave" 
                      style={{ 
                        height: `${Math.random() * 20 + 10}px`, 
                        animationDelay: `${i * 0.1}s`,
                        opacity: 0.6 + (i * 0.05)
                      }}
                    />
                  ))}
                </div>
                <div className="text-rose-400 font-bold text-2xl font-serif tracking-wide">Jana</div>
                <div className={`flex items-center gap-2 text-[10px] mt-2 uppercase tracking-[0.2em] font-bold ${isDarkMode ? 'text-zinc-500' : 'text-zinc-400'}`}>
                  <Waves size={12} className="animate-pulse" /> Always here
                </div>
              </div>
            </div>
            
            <div className="mt-16 max-w-lg">
              <h2 className="text-3xl font-serif font-medium mb-4 leading-snug italic text-rose-900/80 dark:text-rose-100/80">
                "Kaho jo bhi dil mein hai, main sun rahi hoon..."
              </h2>
              <p className={`text-sm opacity-60 leading-relaxed max-w-sm mx-auto ${isDarkMode ? 'text-zinc-400' : 'text-zinc-500'}`}>
                Talk to me like you'd talk to a friend. Tell me about your feelings, your day, or just share a moment of silence.
              </p>
            </div>
            
            <div className="mt-12">
              <div className="flex items-center gap-3 text-xs font-semibold px-6 py-3 rounded-full bg-rose-50 text-rose-500 border border-rose-100 shadow-sm animate-pulse">
                <Volume2 size={16} /> Soothing Presence Active
              </div>
            </div>
          </div>
        )}

        {/* Input Bar */}
        {!isLiveMode && (
          <footer className={`p-6 border-t ${isDarkMode ? 'bg-zinc-950 border-zinc-900' : 'bg-white border-rose-50'} backdrop-blur-xl`}>
            <form onSubmit={handleSendMessage} className="max-w-2xl mx-auto flex items-center gap-4">
              <div className="flex-1 relative group">
                <input 
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="Tell me what's on your mind..."
                  className={`w-full py-4 px-6 pr-14 rounded-[2rem] focus:outline-none focus:ring-4 focus:ring-rose-200/20 transition-all border shadow-sm ${
                    isDarkMode 
                      ? 'bg-zinc-900 border-zinc-800 text-zinc-100 placeholder-zinc-600' 
                      : 'bg-[#fffafa] border-rose-100/50 text-zinc-900 placeholder-zinc-400'
                  }`}
                />
                <div className="absolute right-5 top-1/2 -translate-y-1/2 text-rose-200 group-focus-within:text-rose-400 transition-colors">
                  <Sparkles size={20} />
                </div>
              </div>
              <button 
                type="submit"
                disabled={!inputText.trim() || isLoading}
                className="p-4 rounded-full bg-rose-400 hover:bg-rose-500 text-white shadow-xl shadow-rose-200 active:scale-90 transition-all disabled:opacity-30 disabled:scale-100"
              >
                <Send size={20} />
              </button>
            </form>
          </footer>
        )}
      </div>
    </div>
  );
};

export default App;
